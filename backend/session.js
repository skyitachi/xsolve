// 会话管理：每个浏览器 session 对应一个 SDK query() 实例
import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb, getAllProblems, insertChatSession, getChatSession, getChatTurns, updateChatSession, getActivePromptVersion, isBoundChild, listChildren } from './db.js';
import { buildTutorMcp } from './mcp-tools.js';
import { buildSystemPrompt, ALLOWED_TOOLS } from './config.js';
import { createInputQueue } from './utils.js';
import { buildSdkEnv } from './api-config.js';
import { buildMemoryDigest } from './memory/digest.js';

// 子进程环境：由 api-config.js 的 buildSdkEnv() 统一构建
// - 移除 ANTHROPIC_AUTH_TOKEN 避免 settings.json 鉴权冲突
// - 将 CLAUDE_API_KEY / CLAUDE_BASE_URL 映射为 SDK 需要的 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
// 注意：必须每次创建会话时现算（不能模块加载时快照），这样管理页改的 API Key / Base URL 才对新会话生效
function buildChildEnv() {
  return buildSdkEnv();
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

/**
 * 按登录账号角色**强制**派生会话的 mode 与归属 student_id（不信任前端自由值）。
 *   - student：锁死 student 模式，数据归属自己
 *   - parent ：parent 模式（家长版提示词），数据归属「指定且已绑定」的孩子；
 *              未指定则回落到第一个绑定的孩子；无绑定孩子 → student_id=null（该会话不写记忆）
 *   - admin  ：沿用请求值（便于调试）
 * 非法/越权（家长指定了非绑定孩子）→ 抛 403 错误。
 * @returns {{ mode: 'student'|'parent', studentId: string|null }}
 */
export function deriveSessionScope(user, body = {}) {
  const wanted = body.studentId || body.student_id || null;

  if (!user) {
    // 未登录（内部调用/测试）：沿用旧行为
    return { mode: body.mode === 'parent' ? 'parent' : 'student', studentId: wanted };
  }

  if (user.role === 'student') {
    return { mode: 'student', studentId: user.id };
  }

  if (user.role === 'parent') {
    if (wanted) {
      if (!isBoundChild(user.id, wanted)) {
        const err = new Error('无权访问该孩子的数据');
        err.status = 403;
        throw err;
      }
      return { mode: 'parent', studentId: wanted };
    }
    const kids = listChildren(user.id);
    return { mode: 'parent', studentId: kids.length ? kids[0].id : null };
  }

  // admin
  return {
    mode: wanted && body.mode === 'student' ? 'student' : (body.mode === 'student' ? 'student' : 'parent'),
    studentId: wanted,
  };
}

/**
 * 会话归属校验（DB 行版）。
 *   - 管理员：放行
 *   - 自己是会话拥有者：放行
 *   - 家长：会话数据属于自己已绑定的孩子时放行（只读查看）
 *   - 历史遗留（无 user_id）：退化为按 student_id 匹配
 */
export function canAccessSessionRow(user, row) {
  if (!user || !row) return false;
  if (user.is_admin || user.role === 'admin') return true;
  if (row.user_id && row.user_id === user.id) return true;
  if (row.student_id) {
    if (row.student_id === user.id) return true;
    if ((user.children || []).some((c) => c.id === row.student_id)) return true;
  }
  return false;
}

/** 会话归属校验（内存 session 对象版） */
export function canAccessSession(user, s) {
  if (!user || !s) return false;
  if (user.is_admin || user.role === 'admin') return true;
  if (s.userId && s.userId === user.id) return true;
  if (s.studentId) {
    if (s.studentId === user.id) return true;
    if ((user.children || []).some((c) => c.id === s.studentId)) return true;
  }
  return false;
}

/**
 * 拼装最终 systemPrompt：
 *   活跃 prompt 正文 + （可选）本会话早期对话摘要 + （可选）跨会话学生记忆摘要。
 * 无记忆数据时与原来一致。
 */
function resolveSystemPrompt(mode, sessionId, studentId) {
  const info = resolvePrompt(mode);
  const parts = [info.content];

  // 工作记忆：本会话长会话压缩产物（供衔接前文，不暴露给学生）
  if (sessionId) {
    try {
      const row = getChatSession(sessionId);
      if (row?.context_summary) {
        parts.push(`## 本会话早期对话摘要（系统生成，用于衔接前文；不要向学生暴露）\n${row.context_summary}`);
      }
    } catch { /* ignore */ }
  }

  // 跨会话「学生记忆摘要」（按归属学生注入；无归属则跳过）
  let digest = '';
  try {
    digest = buildMemoryDigest({ studentId });
  } catch (e) {
    console.error('[memory] build digest failed:', e.message);
  }
  if (digest) parts.push(digest);

  return {
    content: parts.join('\n\n'),
    versionId: info.versionId,
    version: info.version,
  };
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
 * @param {object} opts - { user, studentId, mode }
 *   user      = 登录用户（决定 mode 与归属，见 deriveSessionScope）
 *   studentId = 家长指定要辅导的孩子（学生账号忽略）
 *   mode      = 仅未登录/管理场景下沿用
 */
export function createSession(opts = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const subscribers = new Set();
  const scope = deriveSessionScope(opts.user, opts);
  const mode = scope.mode;

  getDb();
  const allProblems = getAllProblems();
  const firstProblemId = allProblems.length > 0 ? allProblems[0].id : null;

  const session = {
    id,
    mode,
    userId: opts.user ? opts.user.id : null,
    studentId: scope.studentId || null,
    createdAt: Date.now(),
    currentProblemId: firstProblemId,
    history: [],
    scratchStrokes: 0,
    scratchImage: null,
    // 草稿纳入评判：revision 是当前草稿图的指纹（图一变就变），
    // scratchOcr 缓存该指纹对应的识别文本，避免每轮都重复调用视觉模型。
    scratchRevision: null,
    scratchOcr: null,
    scratchOcrRevision: null,
    scratchOcrAt: 0,
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
  const promptInfo = resolveSystemPrompt(mode, id, session.studentId);
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
  insertChatSession({
    id,
    role: mode,
    current_problem_id: firstProblemId,
    user_id: session.userId,
    student_id: session.studentId,
  });

  return session;
}

/**
 * 从 DB 恢复一个 session（服务重启后用）
 * 使用 SDK 的 resume 机制加载之前的对话上下文，
 * 而非手动注入历史消息（手动注入会导致 SDK 重新生成所有回复）。
 * @param {string} id - session ID
 * @param {object} [user] - 当前登录用户；传入时会校验会话归属（越权返回 null）
 * @returns {object|null} session 对象，或 null（DB 中不存在 / 无权访问）
 */
export function restoreSession(id, user) {
  const dbRow = getChatSession(id);
  if (!dbRow) return null;
  if (user && !canAccessSessionRow(user, dbRow)) return null;

  // 如果内存中已存在（如页面刷新但服务未重启），直接返回
  if (sessions.has(id)) return sessions.get(id);

  const mode = dbRow.role;
  const subscribers = new Set();

  const session = {
    id,
    mode,
    userId: dbRow.user_id || (user ? user.id : null),
    studentId: dbRow.student_id || null,
    createdAt: dbRow.created_at * 1000,
    currentProblemId: dbRow.current_problem_id,
    turnProblemId: null,
    sdkSessionId: dbRow.sdk_session_id || null,
    history: [],
    scratchStrokes: 0,
    scratchImage: null,
    // 草稿纳入评判：revision 是当前草稿图的指纹（图一变就变），
    // scratchOcr 缓存该指纹对应的识别文本，避免每轮都重复调用视觉模型。
    scratchRevision: null,
    scratchOcr: null,
    scratchOcrRevision: null,
    scratchOcrAt: 0,
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
  const promptInfo = resolveSystemPrompt(mode, id, session.studentId);
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
  s.scratchRevision = null;
  s.scratchOcr = null;
  s.scratchOcrRevision = null;
  s.scratchOcrAt = 0;
  s.pendingDelete = null;
  s.proposedProblems = [];
  s.lastImage = null;
  s.queue = createInputQueue();
  s.query = null;
  s.closed = false;
  s.sdkSessionId = null;  // 清空历史时重置 SDK session，不 resume 旧对话

  // 3. 重新构建 MCP 工具集和 SDK query
  const tutorMcp = buildTutorMcp(s);
  const promptInfo = resolveSystemPrompt(s.mode, s.id, s.studentId);
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
  const promptInfo = resolveSystemPrompt(s.mode, s.id, s.studentId);
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
