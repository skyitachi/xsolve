// 对话 turn controller（SSE 流式响应）
import { sessions } from '../session.js';
import { insertChatTurn, updateChatSession, getChatTurns, getProblem, recordAttempt, getAttemptStats } from '../db.js';
import { compareAnswer } from '../utils.js';
import { judgeTurn } from '../eval/llm-judge.js';
import { judgeSession } from '../eval/session-judge.js';
import { evalStudent } from '../eval/student-eval.js';
import { consolidateStudent } from '../memory/consolidate.js';
import { maybeCompressSession } from '../memory/compress.js';
import { MEMORY_CONSOLIDATE_INTERVAL } from '../config.js';

// 每 N 个 turn 自动触发一次 session 级评估
const SESSION_EVAL_INTERVAL = 5;

// POST /api/session/:id/turn
export function handleTurn(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });

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
      const tool_calls = [...toolCallIndex.values()];
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
      });

      // 记忆落库：把本轮 check_answer 的结果**确定性**写入 student_attempts（无 LLM）。
      // 即使 AI 忘记调用 record_history 工具，答题流水也不会丢。
      autoLogAttempts(s, turnId, tool_calls);

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
        }, s.id, s.currentProblemId).catch(err => {
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
          const stats = getAttemptStats('me');
          if (allTurns.length % MEMORY_CONSOLIDATE_INTERVAL === 0 && stats.total > 0) {
            consolidateStudent('me').catch(err => {
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
  res.on('close', () => { unsubscribe(); });

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

// 确定性落库：扫描本轮工具调用，把每个 check_answer 的结果写入 student_attempts。
// 答案对错用 compareAnswer(user_answer, problem.answer) 判定，不依赖 AI 自报的 correct。
function autoLogAttempts(session, turnId, toolCalls) {
  for (const tc of toolCalls || []) {
    if (!/check_answer$/.test(tc.name || '')) continue;
    const pid = tc.input?.problem_id;
    const ans = tc.input?.user_answer;
    if (pid == null || ans == null) continue;
    try {
      const p = getProblem(pid);
      recordAttempt({
        student_id: 'me',
        session_id: session.id,
        turn_id: turnId,
        problem_id: pid,
        topic: p ? p.topic : null,
        user_answer: String(ans),
        correct: p ? compareAnswer(String(ans), p.answer) : false,
      });
    } catch (e) {
      console.error('[turn] auto attempt log failed:', e.message);
    }
  }
}

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* ignore */
  }
}
