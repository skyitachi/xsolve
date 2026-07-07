// 会话管理：每个浏览器 session 对应一个 SDK query() 实例
import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb, getAllProblems } from './db.js';
import { buildTutorMcp } from './mcp-tools.js';
import { buildSystemPrompt, ALLOWED_TOOLS, CLAUDE_MODEL } from './config.js';
import { createInputQueue } from './utils.js';

// 会话注册表
export const sessions = new Map();

/**
 * 创建一个 SDK 驱动的 session
 * @param {object} opts - { mode: 'student'|'parent' }
 */
export function createSession(opts = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const subscribers = new Set();
  const mode = opts.mode === 'parent' ? 'parent' : 'student';

  getDb();
  const allProblems = getAllProblems();
  const firstProblemId = allProblems.length > 0 ? allProblems[0].id : null;

  const session = {
    id,
    mode,
    createdAt: Date.now(),
    currentProblemId: firstProblemId,
    history: [],
    scratchStrokes: 0,
    scratchImage: null,
    pendingDelete: null,
    proposedProblems: [],
    lastImage: null,
    queue: createInputQueue(),
    query: null,
    runPromise: null,
    closed: false,
    emit(event, data) {
      for (const sub of subscribers) sub(event, data);
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  };

  // 注册 MCP 工具集
  const tutorMcp = buildTutorMcp(session);

  session.query = query({
    prompt: session.queue.iterable(),
    options: {
      systemPrompt: buildSystemPrompt(mode),
      mcpServers: { tutor: tutorMcp },
      tools: [],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      persistSession: false,
      includePartialMessages: true,
      // 捕获 Claude Code 子进程的 stderr，避免真实错误被 SDK 默认吞掉（默认为 "ignore"）
      stderr: (data) => {
        const text = (typeof data === 'string' ? data : data.toString()).trimEnd();
        if (text) console.error('[claude-code]', text);
      },
      ...(CLAUDE_MODEL ? { model: CLAUDE_MODEL } : {}),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'selflearning/0.1.0' }
    }
  });

  // 后台循环：把 SDK 消息推给当前订阅者
  session.runPromise = (async () => {
    try {
      for await (const msg of session.query) {
        if (session.closed) break;
        session.emit('sdk_message', msg);
      }
    } catch (e) {
      const errMsg = e.message || String(e);
      let detail = errMsg;
      if (e.status) detail = `[HTTP ${e.status}] ${errMsg}`;
      if (e.type === 'authentication_error' || /api key|auth/i.test(errMsg)) {
        detail = `鉴权失败：请检查 ANTHROPIC_API_KEY 是否正确设置。\n${errMsg}`;
      } else if (/rate limit|overloaded/i.test(errMsg)) {
        detail = `API 限流/过载，请稍后重试：\n${errMsg}`;
      } else if (/network|fetch|ECONNRESET|ETIMEDOUT/i.test(errMsg)) {
        detail = `网络错误，请检查网络连接：\n${errMsg}`;
      }
      console.error('[sdk error]', e);
      session.emit('error', { message: detail });
      session.emit('done', {});
    }
  })();

  sessions.set(id, session);
  return session;
}

/**
 * 销毁会话
 */
export async function destroySession(s) {
  if (!s || s.closed) return;
  s.closed = true;
  try { s.queue.close(); } catch { /* ignore */ }
  try { s.query && s.query.close && s.query.close(); } catch { /* ignore */ }
  sessions.delete(s.id);
}

/**
 * 清空会话历史（类似 Claude Code 的 /clear）
 * 保留 session ID 和当前题目，但销毁底层 SDK 进程并重新启动一个干净的对话。
 * @param {object} s - session 对象
 * @returns {Promise<object>} 同一个 session（ID 不变，但 SDK 进程已重置）
 */
export async function clearSessionHistory(s) {
  if (!s || s.closed) return s;

  // 1. 停止旧 SDK 进程
  const oldSubscribers = new Set();
  s._swapSubscribers = oldSubscribers;
  try { s.queue.close(); } catch { /* ignore */ }
  try { s.query && s.query.close && s.query.close(); } catch { /* ignore */ }

  // 2. 重置状态
  s.history = [];
  s.scratchStrokes = 0;
  s.scratchImage = null;
  s.pendingDelete = null;
  s.proposedProblems = [];
  s.lastImage = null;
  s.queue = createInputQueue();
  s.query = null;
  s.closed = false;

  // 3. 重新构建 MCP 工具集和 SDK query
  const tutorMcp = buildTutorMcp(s);

  s.query = query({
    prompt: s.queue.iterable(),
    options: {
      systemPrompt: buildSystemPrompt(s.mode),
      mcpServers: { tutor: tutorMcp },
      tools: [],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      persistSession: false,
      includePartialMessages: true,
      stderr: (data) => {
        const text = (typeof data === 'string' ? data : data.toString()).trimEnd();
        if (text) console.error('[claude-code]', text);
      },
      ...(CLAUDE_MODEL ? { model: CLAUDE_MODEL } : {}),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'selflearning/0.1.0' }
    }
  });

  // 4. 重启后台循环
  s.runPromise = (async () => {
    try {
      for await (const msg of s.query) {
        if (s.closed) break;
        s.emit('sdk_message', msg);
      }
    } catch (e) {
      const errMsg = e.message || String(e);
      let detail = errMsg;
      if (e.status) detail = `[HTTP ${e.status}] ${errMsg}`;
      if (e.type === 'authentication_error' || /api key|auth/i.test(errMsg)) {
        detail = `鉴权失败：请检查 ANTHROPIC_API_KEY 是否正确设置。\n${errMsg}`;
      } else if (/rate limit|overloaded/i.test(errMsg)) {
        detail = `API 限流/过载，请稍后重试：\n${errMsg}`;
      } else if (/network|fetch|ECONNRESET|ETIMEDOUT/i.test(errMsg)) {
        detail = `网络错误，请检查网络连接：\n${errMsg}`;
      }
      console.error('[sdk error]', e);
      s.emit('error', { message: detail });
      s.emit('done', {});
    }
  })();

  return s;
}

/**
 * 重置会话：销毁旧 session 并创建一个新 session（新 ID）
 * 用于"新建对话覆盖老 session"场景
 * @param {string} oldId - 旧 session ID
 * @param {object} opts - { mode }
 * @returns {Promise<object>} 新 session
 */
export async function resetSession(oldId, opts = {}) {
  const old = sessions.get(oldId);
  if (old) await destroySession(old);
  return createSession(opts);
}
