// 对话 turn controller（SSE 流式响应）
import { sessions, canAccessSession } from '../session.js';
import { insertChatTurn, updateChatSession, getChatTurns, getProblem, recordAttempt, getAttemptStats } from '../db.js';
import { compareAnswer } from '../utils.js';
import { judgeTurn } from '../eval/llm-judge.js';
import { judgeSession } from '../eval/session-judge.js';
import { evalStudent } from '../eval/student-eval.js';
import { consolidateStudent } from '../memory/consolidate.js';
import { maybeCompressSession } from '../memory/compress.js';
import { runVisionHttp } from '../vision.js';
import { formatScratchForPrompt, parseScratchResult } from '../scratch.js';
import {
  MEMORY_CONSOLIDATE_INTERVAL,
  GUEST_MAX_TURNS,
  SCRATCH_VISION_PROMPT,
  SCRATCH_AUTO_RECOGNIZE,
  SCRATCH_OCR_TIMEOUT_MS,
  SCRATCH_OCR_RETRIES,
} from '../config.js';

// 每 N 个 turn 自动触发一次 session 级评估
const SESSION_EVAL_INTERVAL = 5;

// POST /api/session/:id/turn
export async function handleTurn(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!canAccessSession(req.user, s)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }

  // 游客试用限额：避免被当作免费 API 长期占用
  if (req.user && req.user.is_guest && GUEST_MAX_TURNS > 0) {
    let used = 0;
    try { used = getChatTurns(s.id).length; } catch { used = 0; }
    if (used >= GUEST_MAX_TURNS) {
      return res.status(403).json({
        error: `试用已用完（${GUEST_MAX_TURNS} 轮），注册账号后可继续`,
        guest_limit: true,
        limit: GUEST_MAX_TURNS,
      });
    }
  }

  const body = req.body || {};
  const userMsg = (body.message || '').trim();
  const imgBody = body.image;
  const audioBody = body.audio;
  if (!userMsg && !imgBody && !audioBody) {
    return res.status(400).json({ error: 'empty message' });
  }

  // 同步前端状态到 session
  if (typeof body.currentProblemId === 'string') s.currentProblemId = body.currentProblemId;
  if (typeof body.scratchStrokes === 'number') s.scratchStrokes = body.scratchStrokes;

  // 本轮题目锚点快照：AI 处理期间学生若又切了题，本轮的判答落库仍按“提交时”那道题算。
  // 同时写到 session.turnProblemId，让 MCP 工具层（check_answer / record_history）
  // 在一轮对话进行中也能拿到稳定的锚点。
  const turnProblemId = s.currentProblemId || null;
  s.turnProblemId = turnProblemId;

  // 记录 turn 开始时间
  const turnStartTime = Date.now();

  // 累积 AI 输出和工具调用
  let aiTextAccumulator = '';
  // 工具调用按 tool_use.id 归并（stream_event 的 content_block_start 只有空 input，
  // 完整入参由随后的 assistant 消息补齐）
  const toolCallIndex = new Map(); // id -> { name, input }
  let inputTokens = 0;
  let outputTokens = 0;
  let turnError = null;
  let connectionClosed = false;
  // 本轮草稿（自动识别的结果）：既注入给模型，也随 turn 落库供评估层使用
  let turnScratch = { strokes: Number(s.scratchStrokes) || 0, ocr: null, skipped: 'pending' };

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 发送 user 事件（告知前端消息已接收）
  sendSSE(res, 'user', { message: userMsg, hasImage: !!imgBody, hasAudio: !!audioBody });

  // ---- SSE 批量缓冲：content_block_delta 事件高频到达，合并后批量发送以减少交互次数 ----
  let deltaBuffer = [];
  let flushTimer = null;
  const FLUSH_INTERVAL = 16; // ms（对齐 60fps，降低流式延迟）
  const FLUSH_THRESHOLD = 6; // 缓冲区达到此数量时立即 flush，不等定时器

  function flushDeltas() {
    flushTimer = null;
    if (deltaBuffer.length === 0) return;
    // 将多个 delta 合并为一个批量事件
    sendSSE(res, 'sdk_message', { type: 'stream_event', event: { type: 'content_block_deltas_batch', deltas: deltaBuffer } });
    deltaBuffer = [];
  }

  function scheduleFlush() {
    // 缓冲区足够大时立即 flush，减少长文本的流式延迟
    if (deltaBuffer.length >= FLUSH_THRESHOLD) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushDeltas();
      return;
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(flushDeltas, FLUSH_INTERVAL);
    }
  }

  // session 对象使用自定义 subscribe/unsubscribe 模式（非 EventEmitter）
  const unsubscribe = s.subscribe((event, data) => {
    // 拦截 content_block_delta 事件，批量发送
    if (event === 'sdk_message' &&
        data.type === 'stream_event' &&
        data.event?.type === 'content_block_delta') {

      // thinking_delta 不需要发送到前端（前端不展示思考内容），直接丢弃以节省带宽
      if (data.event.delta?.type === 'thinking_delta') {
        return;
      }

      deltaBuffer.push({ index: data.event.index, delta: data.event.delta });
      scheduleFlush();
      return;
    }

    // 非批量事件先 flush 缓冲区
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushDeltas();
    }

    // 过滤掉不需要发送到前端的系统消息（thinking_tokens 等思考过程元数据）
    if (event === 'sdk_message' &&
        data.type === 'system' &&
        data.subtype === 'thinking_tokens') {
      return;
    }

    sendSSE(res, event, data);

    // 累积 AI 输出和工具调用用于持久化
    if (event === 'sdk_message') {
      if (data.type === 'stream_event' && data.event?.type === 'content_block_start') {
        const block = data.event.content_block;
        if (block?.type === 'tool_use') {
          // 先占位（此时 input 通常为空），完整入参随后由 assistant 消息覆盖
          const key = block.id || ('idx_' + data.event.index);
          toolCallIndex.set(key, { name: block.name, input: block.input || {} });
        }
      } else if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
        // 完整的 assistant 消息：含每个 tool_use 的完整 input
        for (const block of data.message.content) {
          if (block?.type === 'tool_use') {
            const key = block.id || (block.name + ':' + JSON.stringify(block.input || {}));
            toolCallIndex.set(key, { name: block.name, input: block.input || {} });
          }
        }
      } else if (data.type === 'stream_event' && data.event?.type === 'message_delta') {
        const usage = data.event.usage;
        if (usage) {
          outputTokens = usage.output_tokens || outputTokens;
        }
      } else if (data.type === 'result') {
        // SDK result 消息：result 是字符串（AI 回复文本），usage 在顶层
        if (typeof data.result === 'string') {
          aiTextAccumulator = data.result;
        } else if (data.result?.content) {
          for (const block of data.result.content) {
            if (block.type === 'text') aiTextAccumulator += block.text;
          }
        }
        if (data.usage) {
          inputTokens = data.usage.input_tokens || inputTokens;
          outputTokens = data.usage.output_tokens || outputTokens;
        }
      }
    } else if (event === 'error') {
      turnError = data.message || 'unknown error';
    } else if (event === 'aborted') {
      turnError = 'user_cancelled';
    }

    // 收到最终结果或错误后，发送 done 并关闭连接
    if (connectionClosed) return;

    if (event === 'sdk_message' && data.type === 'result') {
      connectionClosed = true;
      persistTurn();
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    } else if (event === 'error') {
      connectionClosed = true;
      persistTurn();
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    } else if (event === 'aborted') {
      connectionClosed = true;
      persistTurn();
      sendSSE(res, 'aborted', { reason: 'user_cancelled' });
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    } else if (event === 'done') {
      // 安全网：SDK 正常结束但未发 result 消息（session.js for await 循环结束后 emit done）
      connectionClosed = true;
      persistTurn();
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    }
  });

  // 持久化 turn 到 DB
  function persistTurn() {
    try {
      const duration_ms = Date.now() - turnStartTime;
      const ai_message = aiTextAccumulator || null;
      const tool_calls = [...toolCallIndex.values()]
        .map(tc => anchorToolCallProblemId(tc, turnProblemId));
      const tool_calls_json = JSON.stringify(tool_calls);

      const turnId = insertChatTurn({
        session_id: s.id,
        role: s.mode,
        user_message: userMsg || (imgBody ? '[图片消息]' : '[语音消息]'),
        ai_message,
        tool_calls_json,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        duration_ms,
        error: turnError,
        prompt_version_id: s.promptVersionId || null,
        // 草稿纳入评判：把「这轮有没有动笔」和识别出的草稿内容一起落库，
        // 评估层（thinking_quality / engagement）与学习档案页才有据可依。
        scratch_strokes: turnScratch.strokes || 0,
        scratch_ocr: turnScratch.ocr || null,
      });

      // 记忆落库：把本轮 check_answer 的结果**确定性**写入 student_attempts（无 LLM）。
      // 即使 AI 忘记调用 record_history 工具，答题流水也不会丢。
      autoLogAttempts(s, turnId, tool_calls, turnProblemId, (turnScratch.strokes || 0) > 0);

      // 如果是第一条 turn，更新 session title
      if (userMsg) {
        updateChatSession(s.id, {
          title: userMsg.slice(0, 20),
          current_problem_id: s.currentProblemId,
        });
      }

      // 异步触发 LLM Judge（不阻塞 SSE 响应）
      if (ai_message && !turnError) {
        judgeTurn({
          id: turnId,
          role: s.mode,
          user_message: userMsg || (imgBody ? '[图片消息]' : '[语音消息]'),
          ai_message,
          tool_calls_json,
          prompt_version_id: s.promptVersionId || null,
          scratch_strokes: turnScratch.strokes || 0,
          scratch_ocr: turnScratch.ocr || null,
        }, s.id, turnProblemId).catch(err => {
          console.error(`[turn] LLM Judge failed for turn ${turnId}:`, err.message);
        });

        // 每 SESSION_EVAL_INTERVAL 个 turn 自动触发 session 级评估
        const allTurns = getChatTurns(s.id);
        if (allTurns.length >= 3 && allTurns.length % SESSION_EVAL_INTERVAL === 0) {
          judgeSession(s.id).catch(err => {
            console.error(`[turn] Session Judge failed for session ${s.id}:`, err.message);
          });
          // 同时触发学生能力评估
          evalStudent(s.id).catch(err => {
            console.error(`[turn] Student Eval failed for session ${s.id}:`, err.message);
          });
        }

        // 学生记忆 P1：每 MEMORY_CONSOLIDATE_INTERVAL 轮、且有作答时，LLM 固化语义画像
        try {
          const sid = s.studentId;
          const stats = sid ? getAttemptStats(sid) : { total: 0 };
          if (sid && allTurns.length % MEMORY_CONSOLIDATE_INTERVAL === 0 && stats.total > 0) {
            consolidateStudent(sid).catch(err => {
              console.error(`[turn] consolidate failed:`, err.message);
            });
          }
        } catch (e) {
          console.error('[turn] consolidate trigger error:', e.message);
        }

        // 学生记忆 P1：长会话压缩（turn 数超阈值时把早期轮次滚动摘要，异步不阻塞）
        maybeCompressSession(s.id).catch(err => {
          console.error(`[turn] compress failed:`, err.message);
        });
      }
    } catch (e) {
      console.error('[turn] persist error:', e);
    }
  }

  // 客户端断开时清理订阅
  let clientGone = false;
  res.on('close', () => { clientGone = true; unsubscribe(); });

  // 构造消息内容并入队
  try {
    let effectiveText = userMsg || '';
    if (imgBody && imgBody.data) {
      s.lastImage = `data:${imgBody.mediaType || 'image/jpeg'};base64,${imgBody.data}`;
      if (effectiveText && !/(图片|image|照片|上传|识别)/i.test(effectiveText)) {
        effectiveText += '\n\n（学生刚刚上传了一张图片。如果你需要查看图片内容，请调用 recognize_problem_image 工具。）';
      } else if (!effectiveText) {
        effectiveText = '（学生上传了一张图片，请调用 recognize_problem_image 工具识别图片内容。）';
      }
    }

    // 当前题目锚点：SDK 会话是长驻的，模型看不到「网页上换题了」这件事，
    // 不注入的话它会接着用历史里那道题的 id 去判答（表现为「切题后提交答案判的是上一题」）。
    // 每轮显式告知当前题，让它不必也不该去猜。
    if (turnProblemId) {
      const tp = getProblem(turnProblemId);
      effectiveText += (effectiveText ? '\n\n' : '') +
        `[系统注入·当前题目锚点] 网页上正在显示的题目 id = ${turnProblemId}` +
        (tp ? `，主题「${tp.topic}」` : '') +
        '。凡涉及判答 / 记录 / 讲解，都必须针对这道题；' +
        '不要沿用历史对话里出现过的其它题目 id，除非你先调用 set_current_problem 切换。';
    }

    // 草稿纳入评判：自动识别当前草稿并注入本轮上下文。
    // 与「题目锚点」同源的问题——模型在长驻 SDK 会话里看不见「学生刚在草稿板上写了什么」，
    // 不注入就只靠它自觉调 recognize_scratch（实测时调时不调）。
    turnScratch = await ensureTurnScratch(s);
    if (turnScratch.strokes > 0) {
      const head = effectiveText ? '\n\n' : '';
      if (turnScratch.ocr) {
        effectiveText += head +
          '[系统注入·学生草稿内容] 这是学生草稿板上手写内容的自动识别结果（可能有笔迹误读），' +
          '用于判断他的思考过程与演算步骤：\n' + turnScratch.ocr + '\n' +
          '答案对错只以 check_answer 的判定为准，不要因为草稿上写了正确答案就判他答对；' +
          '也不要在回复里逐字复述草稿内容或念出置信度。';
      } else {
        effectiveText += head +
          `[系统注入·学生草稿内容] 草稿板上有 ${turnScratch.strokes} 笔内容，但自动识别失败` +
          (turnScratch.skipped === 'disabled' ? '（本部署关闭了自动识别）' : '') +
          '。需要查看时请调用 recognize_scratch；否则不要提起草稿。';
      }
    }

    // 草稿自动识别是异步的（最长 SCRATCH_OCR_TIMEOUT_MS），期间客户端可能已经离开。
    // 离开后没有订阅者，这一轮即使跑了也无人接收、不会被落库 —— 直接不入队，省掉一次模型调用。
    if (clientGone) {
      console.warn('[turn] 客户端在草稿识别期间断开，本轮不入队');
      return;
    }

    const content = [];
    if (audioBody && audioBody.data) {
      content.push({ type: 'audio', source: { type: 'base64', media_type: audioBody.mediaType || 'audio/webm', data: audioBody.data } });
    }
    if (effectiveText) {
      content.push({ type: 'text', text: effectiveText });
    }
    if (content.length === 0) {
      sendSSE(res, 'error', { message: '消息内容为空' });
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
      return;
    }
    const finalContent = content.length === 1 && content[0].type === 'text' ? content[0].text : content;

    s.queue.push({
      type: 'user',
      message: { role: 'user', content: finalContent },
      parent_tool_use_id: null,
      session_id: s.id,
    });
  } catch (e) {
    sendSSE(res, 'error', { message: '消息入队失败: ' + (e.message || String(e)) });
    sendSSE(res, 'done', {});
    setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
  }
}

// 判答/记录类工具：其 problem_id 一律锚定到“本轮题目”。
// 模型在长驻 SDK 会话里很容易沿用历史对话里的旧题目 id，会让「切题后再提交答案」
// 判到上一题，并把错题记到错误的题目上。MCP 工具层（mcp-tools.js anchorProblem）
// 做了同样的锚定，这里同步一遍是为了让落库的 tool_calls_json 与实际判答一致。
const PROBLEM_ANCHORED_TOOL = /(check_answer|record_history)$/;
export function anchorToolCallProblemId(tc, turnProblemId) {
  if (!tc || !turnProblemId) return tc;
  if (!PROBLEM_ANCHORED_TOOL.test(tc.name || '')) return tc;
  const input = tc.input || {};
  if (input.problem_id === turnProblemId) return tc;
  return { ...tc, input: { ...input, problem_id: turnProblemId } };
}

// 确定性落库：扫描本轮工具调用，把每个 check_answer 的结果写入 student_attempts。
// 答案对错用 compareAnswer(user_answer, problem.answer) 判定，不依赖 AI 自报的 correct。
// 归属学生取 session.studentId（学生=自己；家长=被辅导的孩子）；无归属时跳过落库。
function autoLogAttempts(session, turnId, toolCalls, turnProblemId, hadScratch) {
  const studentId = session.studentId;
  if (!studentId) return;
  for (const tc of toolCalls || []) {
    if (!/check_answer$/.test(tc.name || '')) continue;
    // 与工具层一致：以本轮题目为准，避免 AI 的旧 id 污染答题流水
    const pid = turnProblemId || tc.input?.problem_id;
    const ans = tc.input?.user_answer;
    if (pid == null || ans == null) continue;
    try {
      const p = getProblem(pid);
      recordAttempt({
        student_id: studentId,
        session_id: session.id,
        turn_id: turnId,
        problem_id: pid,
        topic: p ? p.topic : null,
        user_answer: String(ans),
        correct: p ? compareAnswer(String(ans), p.answer) : false,
        // 作答时草稿板上有笔迹 → 这次作答是「动了笔的」
        had_scratch: !!hadScratch,
      });
    } catch (e) {
      console.error('[turn] auto attempt log failed:', e.message);
    }
  }
}

// ========== 草稿纳入评判 ==========

/**
 * 保证本轮拿到「当前草稿」的识别文本。
 *
 * 目的：让草稿真正进入判答上下文，而不是指望模型自觉去调 recognize_scratch。
 *  - 草稿为空 / 开关关闭 → 不识别
 *  - 草稿图指纹未变 → 命中 session 缓存，复用上次结果，不重复调视觉模型
 *  - 指纹变了 → 调视觉模型识别，成功则更新缓存
 *  - 识别失败 → 降级返回，不抛异常、不阻塞对话，由注入文本告知模型「识别失败」
 *
 * @param {object} session 会话对象
 * @param {{runVision?: Function}} [deps] 可注入的视觉实现（自测用）
 * @returns {Promise<{strokes:number, ocr:string|null, cached?:boolean, error?:string, skipped?:string}>}
 */
export async function ensureTurnScratch(session, deps = {}) {
  const runVision = deps.runVision || runVisionHttp;
  const strokes = Number(session.scratchStrokes) || 0;

  if (!SCRATCH_AUTO_RECOGNIZE) return { strokes, ocr: null, skipped: 'disabled' };
  if (!session.scratchImage || strokes <= 0) return { strokes, ocr: null, skipped: 'empty' };

  // 草稿没变过 → 复用缓存（这是避免每轮都付一次视觉调用的关键）
  if (session.scratchOcr && session.scratchOcrRevision &&
      session.scratchOcrRevision === session.scratchRevision) {
    return { strokes, ocr: session.scratchOcr, cached: true };
  }

  const attempts = Math.max(0, SCRATCH_OCR_RETRIES) + 1;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const t0 = Date.now();
    try {
      session.emit('ui_event', { type: 'scratch_recognition_started', auto: true, attempt: i + 1 });
      const raw = await runVision(
        session.scratchImage,
        session.emit.bind(session),
        SCRATCH_VISION_PROMPT,
        { timeoutMs: SCRATCH_OCR_TIMEOUT_MS }
      );
      const ocr = formatScratchForPrompt(parseScratchResult(raw));
      if (!ocr) throw new Error('识别结果为空');
      session.scratchOcr = ocr;
      session.scratchOcrRevision = session.scratchRevision;
      session.scratchOcrAt = Date.now();
      session.emit('ui_event', { type: 'scratch_recognition_done', auto: true, elapsed_ms: Date.now() - t0 });
      return { strokes, ocr };
    } catch (e) {
      lastErr = e;
      console.error(`[turn] 草稿自动识别失败 (第 ${i + 1}/${attempts} 次):`, e.message || String(e));
    }
  }
  session.emit('ui_event', { type: 'scratch_recognition_done', auto: true, failed: true });
  return { strokes, ocr: null, error: lastErr ? (lastErr.message || String(lastErr)) : 'unknown' };
}

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* ignore */
  }
}
