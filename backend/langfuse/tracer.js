// Langfuse Tracer: 把 Claude Agent SDK 的 message stream 转换为 Langfuse trace + observations
//
// 核心思路：每个用户 turn = 一个 Langfuse Trace
// SDK 消息流中的每种事件映射为不同类型的 Observation
// Langfuse observation 类型: SPAN, GENERATION, EVENT (必须大写)

import { LANGFUSE_ACTIVE } from './config.js';
import {
  createTrace, updateTrace,
  createObservation, updateObservation,
  createScore, flush
} from './client.js';

/**
 * 创建一个 turn 的 trace context
 * @returns {object} trace context，包含 traceId 和内部状态
 */
export function beginTrace({ sessionId, mode, message, currentProblemId, scratchStrokes }) {
  if (!LANGFUSE_ACTIVE) return null;

  const traceId = createTrace({
    name: 'math-tutor-turn',
    sessionId,
    userId: sessionId,
    input: { message, mode, currentProblemId, scratchStrokes },
    metadata: { mode, sessionId, currentProblemId },
    tags: [mode, 'math-tutor'],
  });

  return {
    traceId,
    mode,
    // 内部状态追踪
    _generationId: null,      // 当前 generation observation
    _thinkingId: null,         // 当前 thinking span
    _toolIds: new Map(),       // content_block index → tool observation id
    _textBuffer: '',           // 累积 text delta
    _thinkingBuffer: '',       // 累积 thinking delta
    _toolInputBuffer: '',      // 累积 tool input json delta
    _currentToolName: '',      // 当前 tool name
    _toolStartTime: null,
    _genStartTime: null,
    _usage: null,
    _model: null,
    _toolCalls: [],
    _startTime: Date.now(),
  };
}

/**
 * 处理 SDK message，创建/更新对应的 Langfuse observation
 * @param {object} ctx - beginTrace 返回的 context
 * @param {object} msg - SDK message
 */
export function handleSdkMessage(ctx, msg) {
  if (!ctx || !LANGFUSE_ACTIVE) return;

  try {
    switch (msg.type) {
      case 'system':
        handleSystem(ctx, msg);
        break;
      case 'stream_event':
        handleStreamEvent(ctx, msg);
        break;
      case 'result':
        handleResult(ctx, msg);
        break;
      default:
        // 其他消息类型（如 assistant, user 等）忽略
        break;
    }
  } catch (e) {
    // tracer 错误不影响主流程
    console.error('[langfuse] tracer error:', e.message);
  }
}

function handleSystem(ctx, msg) {
  if (msg.subtype === 'init') {
    // 记录 model、tools、sdk 版本到 trace metadata
    updateTrace(ctx.traceId, {
      metadata: {
        mode: ctx.mode,
        model: msg.model,
        sdkVersion: msg.claude_code_version,
        tools: msg.tools,
        mcpServers: msg.mcp_servers?.map(s => s.name) || [],
        sessionId: msg.session_id,
      },
    });
    ctx._model = msg.model;
  }
  // status 消息（requesting/idle）不需要创建 observation
}

function handleStreamEvent(ctx, msg) {
  const event = msg.event;
  if (!event) return;

  switch (event.type) {
    case 'message_start':
      // 开始一个 generation observation
      ctx._genStartTime = new Date().toISOString();
      ctx._generationId = createObservation({
        traceId: ctx.traceId,
        type: 'GENERATION',
        name: 'claude-completion',
        model: event.message?.model || ctx._model,
        startTime: ctx._genStartTime,
        input: { messages: '（由 system prompt + 对话历史组成，此处省略）' },
      });
      // 记录 input token usage
      if (event.message?.usage) {
        const inputTokens = event.message.usage.input_tokens || 0;
        const outputTokens = event.message.usage.output_tokens || 0;
        ctx._usage = {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
          unit: 'TOKENS',
        };
      }
      break;

    case 'content_block_start':
      handleContentBlockStart(ctx, event);
      break;

    case 'content_block_delta':
      handleContentBlockDelta(ctx, event);
      break;

    case 'content_block_stop':
      handleContentBlockStop(ctx, event);
      break;

    case 'message_delta':
      // 更新 usage（output tokens）
      if (event.usage?.output_tokens && ctx._usage) {
        ctx._usage.output = event.usage.output_tokens;
        ctx._usage.total = (ctx._usage.input || 0) + (ctx._usage.output || 0);
      }
      if (event.usage?.input_tokens && ctx._usage) {
        ctx._usage.input = event.usage.input_tokens;
        ctx._usage.total = (ctx._usage.input || 0) + (ctx._usage.output || 0);
      }
      break;

    case 'message_stop':
      // 结束 generation
      if (ctx._generationId) {
        updateObservation(ctx.traceId, ctx._generationId, 'GENERATION', {
          output: { text: ctx._textBuffer || '(empty)' },
          endTime: new Date().toISOString(),
          usage: ctx._usage || undefined,
        });
        ctx._generationId = null;
        ctx._textBuffer = '';
      }
      break;
  }
}

function handleContentBlockStart(ctx, event) {
  const cb = event.content_block;
  if (!cb) return;
  const index = event.index;

  switch (cb.type) {
    case 'thinking':
      ctx._thinkingId = createObservation({
        traceId: ctx.traceId,
        type: 'SPAN',
        name: 'thinking',
        startTime: new Date().toISOString(),
      });
      ctx._thinkingBuffer = '';
      break;

    case 'text':
      // text 在 message_start 时已创建 generation，delta 时累积
      break;

    case 'tool_use':
      ctx._toolStartTime = new Date().toISOString();
      ctx._currentToolName = cb.name || 'unknown-tool';
      ctx._toolInputBuffer = '';
      const toolObsId = createObservation({
        traceId: ctx.traceId,
        type: 'SPAN',
        name: cb.name || 'tool-use',
        startTime: ctx._toolStartTime,
        input: { name: cb.name, id: cb.id },
      });
      ctx._toolIds.set(index, toolObsId);
      ctx._toolCalls.push(cb.name);
      break;
  }
}

function handleContentBlockDelta(ctx, event) {
  const delta = event.delta;
  if (!delta) return;

  switch (delta.type) {
    case 'thinking_delta':
      ctx._thinkingBuffer += delta.thinking || '';
      break;

    case 'text_delta':
      ctx._textBuffer += delta.text || '';
      break;

    case 'input_json_delta':
      ctx._toolInputBuffer += delta.partial_json || '';
      break;
  }
}

function handleContentBlockStop(ctx, event) {
  const index = event.index;

  // 结束 thinking span
  if (ctx._thinkingId && index === 0) {
    // thinking 通常是第一个 block
    updateObservation(ctx.traceId, ctx._thinkingId, 'SPAN', {
      output: { text: ctx._thinkingBuffer.slice(0, 2000) || '(empty)' },
      endTime: new Date().toISOString(),
    });
    ctx._thinkingId = null;
    ctx._thinkingBuffer = '';
  }

  // 结束 tool observation
  const toolObsId = ctx._toolIds.get(index);
  if (toolObsId) {
    let parsedInput = null;
    try {
      parsedInput = JSON.parse(ctx._toolInputBuffer || '{}');
    } catch { /* ignore parse error */ }

    updateObservation(ctx.traceId, toolObsId, 'SPAN', {
      input: { name: ctx._currentToolName, args: parsedInput },
      endTime: new Date().toISOString(),
    });
    ctx._toolIds.delete(index);
    ctx._toolInputBuffer = '';
    ctx._currentToolName = '';
    ctx._toolStartTime = null;
  }
}

function handleResult(ctx, msg) {
  // result 消息包含最终结果
  const outputText = msg.result;
  const durationMs = Date.now() - ctx._startTime;

  // 更新 trace 的 output
  updateTrace(ctx.traceId, {
    output: {
      text: typeof outputText === 'string' ? outputText.slice(0, 5000) : JSON.stringify(outputText).slice(0, 5000),
      toolCalls: ctx._toolCalls,
      durationMs,
    },
    metadata: {
      mode: ctx.mode,
      model: ctx._model,
      toolCallCount: ctx._toolCalls.length,
      toolCalls: ctx._toolCalls,
      durationMs,
      usage: ctx._usage,
    },
  });

  // 自动规则评分（简单规则，无需 LLM）
  autoScore(ctx);
}

/**
 * 基于规则的自动评分（写入 Langfuse Score）
 * 这些是客观指标，LLM-as-Judge 的主观评分在 Langfuse UI 中配置
 */
function autoScore(ctx) {
  // 1. 是否调用了 get_current_problem（每轮应先读题）
  const calledGetProblem = ctx._toolCalls.includes('mcp__tutor__get_current_problem');
  createScore({
    traceId: ctx.traceId,
    name: 'tool_get_problem_called',
    value: calledGetProblem ? 1 : 0,
    dataType: 'BOOLEAN',
    comment: calledGetProblem ? '调用了 get_current_problem' : '未调用 get_current_problem',
  });

  // 2. 是否调用了 calc（涉及计算时应调用）
  const calledCalc = ctx._toolCalls.includes('mcp__tutor__calc');
  // 只有有工具调用时才评分（纯对话不需要 calc）
  if (ctx._toolCalls.length > 0) {
    createScore({
      traceId: ctx.traceId,
      name: 'tool_calc_called',
      value: calledCalc ? 1 : 0,
      dataType: 'BOOLEAN',
      comment: calledCalc ? '调用了 calc' : '有工具调用但未调 calc',
    });
  }

  // 3. 工具调用总数
  createScore({
    traceId: ctx.traceId,
    name: 'tool_call_count',
    value: ctx._toolCalls.length,
    dataType: 'NUMERIC',
    comment: `本轮共调用 ${ctx._toolCalls.length} 次工具`,
  });

  // 4. 响应时长（秒）
  const durationSec = Math.round((Date.now() - ctx._startTime) / 1000);
  createScore({
    traceId: ctx.traceId,
    name: 'response_duration_sec',
    value: durationSec,
    dataType: 'NUMERIC',
    comment: `响应时长 ${durationSec} 秒`,
  });
}

/**
 * 结束 trace（出错或完成时调用）
 */
export function endTrace(ctx, { error } = {}) {
  if (!ctx || !LANGFUSE_ACTIVE) return;

  if (error) {
    // 创建一个 error event observation
    createObservation({
      traceId: ctx.traceId,
      type: 'EVENT',
      name: 'error',
      level: 'ERROR',
      startTime: new Date().toISOString(),
      metadata: { error: error.message || String(error) },
    });

    updateTrace(ctx.traceId, {
      metadata: { error: error.message || String(error), durationMs: Date.now() - ctx._startTime },
    });
  }

  // 尝试 flush
  flush().catch(() => {});
}
