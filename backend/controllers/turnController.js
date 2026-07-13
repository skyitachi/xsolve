// 对话 turn controller（SSE 流式响应）
import { sessions } from '../session.js';
import { insertChatTurn, updateChatSession } from '../db.js';
import { judgeTurn } from '../eval/llm-judge.js';

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
  let toolCallsAccumulator = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turnError = null;

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
  const FLUSH_INTERVAL = 50; // ms

  function flushDeltas() {
    flushTimer = null;
    if (deltaBuffer.length === 0) return;
    // 将多个 delta 合并为一个批量事件
    sendSSE(res, 'sdk_message', { type: 'stream_event', event: { type: 'content_block_deltas_batch', deltas: deltaBuffer } });
    deltaBuffer = [];
  }

  function scheduleFlush() {
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
          toolCallsAccumulator.push({ name: block.name, input: block.input || {} });
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
    if (event === 'sdk_message' && data.type === 'result') {
      // 持久化 turn 到 DB
      persistTurn();
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    } else if (event === 'error') {
      persistTurn();
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    } else if (event === 'aborted') {
      persistTurn();
      sendSSE(res, 'aborted', { reason: 'user_cancelled' });
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    }
  });

  // 持久化 turn 到 DB
  function persistTurn() {
    try {
      const duration_ms = Date.now() - turnStartTime;
      const ai_message = aiTextAccumulator || null;
      const tool_calls_json = JSON.stringify(toolCallsAccumulator);

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

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* ignore */
  }
}
