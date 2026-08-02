// 会话管理：每个浏览器 session 对应一个 SDK query() 实例
import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb, getAllProblems, insertChatSession, getChatSession, getChatTurns, updateChatSession, getActivePromptVersion } from './db.js';
import { buildTutorMcp } from './mcp-tools.js';
import { buildSystemPrompt, ALLOWED_TOOLS } from './config.js';
import { createInputQueue } from './utils.js';

// 子进程环境：继承主进程，但移除 ANTHROPIC_AUTH_TOKEN。
// 原因：~/.claude/settings.json 若设了 ANTHROPIC_AUTH_TOKEN，SDK 会优先用它（Bearer）而非 .env 的
// ANTHROPIC_API_KEY（x-api-key），导致打到错误的端点 401。配合 settingSources:['project'] 不读 user settings。
// 注意：必须每次创建会话时现算（不能模块加载时快照），这样管理页改的 API Key / Base URL 才对新会话生效。
function buildChildEnv() {
  const e = { ...process.env };
  delete e.ANTHROPIC_AUTH_TOKEN;
  e.CLAUDE_AGENT_SDK_CLIENT_APP = 'selflearning/0.1.0';
  return e;
}

// 会话注册表
export const sessions = new Map();

/**
 * 获取活跃 prompt 内容和版本 ID
 * 优先从 DB 读取，DB 无数据时 fallback 到 config.js 硬编码值
 */
function resolvePrompt(mode) {
  const active = getActivePromptVersion(mode);
  if (active) {
    return { content: active.content, versionId: active.id, version: active.version };
  }
  // Fallback: 首次启动 DB 尚未 seed 完成时
  return { content: buildSystemPrompt(mode), versionId: null, version: 0 };
}

// 从 SDK result 消息中捕获 session_id 并持久化到 DB（供后续 resume 用）
function captureSdkSessionId(session, msg) {
  if (msg.type === 'result' && msg.session_id && !session.sdkSessionId) {
    session.sdkSessionId = msg.session_id;
    try { updateChatSession(session.id, { sdk_session_id: msg.session_id }); } catch { /* ignore */ }
  }
}

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
    sdkSessionId: null,
    emit(event, data) {
      for (const sub of subscribers) sub(event, data);
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  };

  // 注册 MCP 工具集
  const tutorMcp = buildTutorMcp(session);

  // 从 DB 获取活跃 prompt
  const promptInfo = resolvePrompt(mode);
  session.promptVersionId = promptInfo.versionId;

  session.query = query({
    prompt: session.queue.iterable(),
    options: {
      systemPrompt: promptInfo.content,
      mcpServers: { tutor: tutorMcp },
      tools: [],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],        // 不读 ~/.claude/settings.json，避免其 ANTHROPIC_AUTH_TOKEN 干扰 .env
      includePartialMessages: true,
      // 捕获 Claude Code 子进程的 stderr，避免真实错误被 SDK 默认吞掉（默认为 "ignore"）
      stderr: (data) => {
        const text = (typeof data === 'string' ? data : data.toString()).trimEnd();
        if (text) console.error('[claude-code]', text);
      },
      ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
      env: buildChildEnv()
    }
  });

  // 后台循环：把 SDK 消息推给当前订阅者
  session.runPromise = (async () => {
    try {
      for await (const msg of session.query) {
        if (session.closed) break;
        captureSdkSessionId(session, msg);
        session.emit('sdk_message', msg);
      }
      // 正常结束后发 done（安全网：确保即使 result 消息未到达，订阅者也能收到 done）
      session.emit('done', {});
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

  // 持久化到 DB
  insertChatSession({ id, role: mode, current_problem_id: firstProblemId });

  return session;
}

/**
 * 从 DB 恢复一个 session（服务重启后用）
 * 使用 SDK 的 resume 机制加载之前的对话上下文，
 * 而非手动注入历史消息（手动注入会导致 SDK 重新生成所有回复）。
 * @param {string} id - session ID
 * @returns {object|null} session 对象，或 null（DB 中不存在）
 */
export function restoreSession(id) {
  const dbRow = getChatSession(id);
  if (!dbRow) return null;

  // 如果内存中已存在（如页面刷新但服务未重启），直接返回
  if (sessions.has(id)) return sessions.get(id);

  const mode = dbRow.role;
  const subscribers = new Set();

  const session = {
    id,
    mode,
    createdAt: dbRow.created_at * 1000,
    currentProblemId: dbRow.current_problem_id,
    sdkSessionId: dbRow.sdk_session_id || null,
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

  // 从 DB 获取活跃 prompt
  const promptInfo = resolvePrompt(mode);
  session.promptVersionId = promptInfo.versionId;

  // 使用 SDK resume 机制恢复对话上下文
  // SDK 会从持久化存储中加载之前的对话历史，无需手动注入
  const resumeOpts = session.sdkSessionId
    ? { resume: session.sdkSessionId }
    : {};

  session.query = query({
    prompt: session.queue.iterable(),
    options: {
      systemPrompt: promptInfo.content,
      mcpServers: { tutor: tutorMcp },
      tools: [],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],        // 不读 ~/.claude/settings.json，避免其 ANTHROPIC_AUTH_TOKEN 干扰 .env
      includePartialMessages: true,
      stderr: (data) => {
        const text = (typeof data === 'string' ? data : data.toString()).trimEnd();
        if (text) console.error('[claude-code]', text);
      },
      ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
      ...resumeOpts,
      env: buildChildEnv()
    }
  });

  // 后台循环
  session.runPromise = (async () => {
    try {
      for await (const msg of session.query) {
        if (session.closed) break;
        captureSdkSessionId(session, msg);
        session.emit('sdk_message', msg);
      }
      // 正常结束后发 done（安全网：确保即使 result 消息未到达，订阅者也能收到 done）
      session.emit('done', {});
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
  s.sdkSessionId = null;  // 清空历史时重置 SDK session，不 resume 旧对话

  // 3. 重新构建 MCP 工具集和 SDK query
  const tutorMcp = buildTutorMcp(s);
  const promptInfo = resolvePrompt(s.mode);
  s.promptVersionId = promptInfo.versionId;

  s.query = query({
    prompt: s.queue.iterable(),
    options: {
      systemPrompt: promptInfo.content,
      mcpServers: { tutor: tutorMcp },
      tools: [],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],        // 不读 ~/.claude/settings.json，避免其 ANTHROPIC_AUTH_TOKEN 干扰 .env
      includePartialMessages: true,
      stderr: (data) => {
        const text = (typeof data === 'string' ? data : data.toString()).trimEnd();
        if (text) console.error('[claude-code]', text);
      },
      ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
      env: buildChildEnv()
    }
  });

  // 4. 重启后台循环
  s.runPromise = (async () => {
    try {
      for await (const msg of s.query) {
        if (s.closed) break;
        captureSdkSessionId(s, msg);
        s.emit('sdk_message', msg);
      }
      s.emit('done', {});
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
 * 中止当前正在进行的 turn（不销毁 session，保留历史）
 * 停止当前 SDK 查询进程，重启一个新的查询进程。
 * @param {object} s - session 对象
 */
export async function abortTurn(s) {
  if (!s || s.closed) return;

  // 1. 通知订阅者：被用户中止
  s.emit('aborted', { reason: 'user_cancelled' });

  // 2. 停止旧 SDK 进程
  try { s.queue.close(); } catch { /* ignore */ }
  try { s.query && s.query.close && s.query.close(); } catch { /* ignore */ }

  // 3. 重建队列和查询（保留历史，不清空）
  s.queue = createInputQueue();
  s.query = null;

  const tutorMcp = buildTutorMcp(s);
  const promptInfo = resolvePrompt(s.mode);
  s.promptVersionId = promptInfo.versionId;

  s.query = query({
    prompt: s.queue.iterable(),
    options: {
      systemPrompt: promptInfo.content,
      mcpServers: { tutor: tutorMcp },
      tools: [],
      allowedTools: ALLOWED_TOOLS,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],        // 不读 ~/.claude/settings.json，避免其 ANTHROPIC_AUTH_TOKEN 干扰 .env
      includePartialMessages: true,
      stderr: (data) => {
        const text = (typeof data === 'string' ? data : data.toString()).trimEnd();
        if (text) console.error('[claude-code]', text);
      },
      ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
      env: buildChildEnv()
    }
  });

  // 4. 重启后台循环
  s.runPromise = (async () => {
    try {
      for await (const msg of s.query) {
        if (s.closed) break;
        captureSdkSessionId(s, msg);
        s.emit('sdk_message', msg);
      }
      s.emit('done', {});
    } catch (e) {
      const errMsg = e.message || String(e);
      console.error('[sdk error after abort]', e);
      s.emit('error', { message: errMsg });
      s.emit('done', {});
    }
  })();
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
