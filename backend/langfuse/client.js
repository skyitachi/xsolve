// Langfuse HTTP API 客户端
// 批量异步发送 trace/observation/score，不阻塞主流程

import { randomUUID } from 'node:crypto';
import { LANGFUSE_ACTIVE, LANGFUSE_HOST, getAuthHeader, shouldSample } from './config.js';

// 批量队列
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 1000;

let queue = [];
let flushTimer = null;
let isFlushing = false;

function ensureTimer() {
  if (flushTimer || !LANGFUSE_ACTIVE) return;
  flushTimer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL_MS);
  // 不阻止进程退出
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * 入队一个事件（trace-create / observation-create / score-create）
 */
export function enqueue(event) {
  if (!LANGFUSE_ACTIVE || !shouldSample()) return;
  queue.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...event });
  ensureTimer();
  if (queue.length >= BATCH_SIZE) {
    flush().catch(() => {});
  }
}

/**
 * 批量发送队列中的事件到 Langfuse ingestion API
 */
export async function flush() {
  if (!LANGFUSE_ACTIVE || isFlushing || queue.length === 0) return;
  isFlushing = true;
  const batch = queue.splice(0, BATCH_SIZE);
  try {
    const resp = await fetch(`${LANGFUSE_HOST}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader(),
      },
      body: JSON.stringify({ batch }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[langfuse] ingestion failed: ${resp.status} ${text.slice(0, 500)}`);
      // 失败的事件丢弃，不重试（避免无限堆积）
    } else {
      const data = await resp.json().catch(() => ({}));
      if (data.errors && data.errors.length > 0) {
        console.error(`[langfuse] ingestion partial errors:`, JSON.stringify(data.errors).slice(0, 500));
      }
    }
  } catch (e) {
    console.error(`[langfuse] flush error: ${e.message}`);
  } finally {
    isFlushing = false;
    // 如果队列中还有数据，继续 flush
    if (queue.length > 0) {
      setTimeout(() => flush().catch(() => {}), 100);
    }
  }
}

/**
 * 进程退出前 flush
 */
export async function shutdown() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
}

// ========== 便捷构造函数 ==========

/**
 * 创建 trace
 * @returns {string} traceId
 */
export function createTrace({ name = 'math-tutor-turn', sessionId, userId, input, metadata, tags }) {
  const traceId = randomUUID();
  enqueue({
    type: 'trace-create',
    body: {
      id: traceId,
      name,
      sessionId,
      userId,
      input,
      metadata,
      tags: tags || [],
    },
  });
  return traceId;
}

/**
 * 创建 observation（SPAN/GENERATION/EVENT）
 * @returns {string} observationId
 */
export function createObservation({ traceId, type = 'SPAN', name, input, output, metadata, model, startTime, endTime, usage, level }) {
  const obsId = randomUUID();
  const body = {
    id: obsId,
    traceId,
    type,
    name: name || type,
    startTime: startTime || new Date().toISOString(),
  };
  if (input !== undefined) body.input = input;
  if (output !== undefined) body.output = output;
  if (metadata !== undefined) body.metadata = metadata;
  if (model !== undefined) body.model = model;
  if (usage !== undefined) body.usage = usage;
  if (level !== undefined) body.level = level;
  if (endTime !== undefined) body.endTime = endTime;

  enqueue({
    type: 'observation-create',
    body,
  });
  return obsId;
}

/**
 * 更新 observation（添加 output/endTime）
 * @param {string} traceId - 关联的 trace ID
 * @param {string} obsId - observation ID
 * @param {string} obsType - observation 类型（GENERATION/SPAN/EVENT）
 */
export function updateObservation(traceId, obsId, obsType, { output, endTime, metadata, usage, level }) {
  enqueue({
    type: 'observation-update',
    body: {
      id: obsId,
      traceId,
      type: obsType,
      ...(output !== undefined && { output }),
      ...(endTime !== undefined && { endTime }),
      ...(metadata !== undefined && { metadata }),
      ...(usage !== undefined && { usage }),
      ...(level !== undefined && { level }),
    },
  });
}

/**
 * 更新 trace（使用 trace-create upsert，Langfuse v3 不支持 trace-update）
 */
export function updateTrace(traceId, { output, metadata }) {
  enqueue({
    type: 'trace-create',
    body: {
      id: traceId,
      ...(output !== undefined && { output }),
      ...(metadata !== undefined && { metadata }),
    },
  });
}

/**
 * 创建 score
 */
export function createScore({ traceId, name, value, dataType = 'NUMERIC', comment, observationId }) {
  enqueue({
    type: 'score-create',
    body: {
      id: randomUUID(),
      traceId,
      name,
      value,
      dataType,
      ...(comment && { comment }),
      ...(observationId && { observationId }),
    },
  });
}
