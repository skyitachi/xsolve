import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_PROMPTS } from './prompt-seeds.js';
import { fileURLToPath } from 'url';
import { PROBLEMS as BUILTIN_PROBLEMS } from './problems.js';
import { MASTERY_HALFLIFE_DAYS, MASTERY_LEARNING_RATE, BOOTSTRAP_STUDENT_USERNAME, BOOTSTRAP_STUDENT_PASSWORD, AUDIT_RETENTION_DAYS, GUEST_USERNAME_PREFIX } from './config.js';
import { hashPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'xsolve.db');

let db = null;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDb() {
  if (db) return db;
  ensureDir(DB_PATH);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  seedBuiltinProblems();
  seedPromptVersions();
  seedBootstrapUser();
  // P2：启动时清理到期游客、过期登录流水与超期审计日志
  try { purgeExpiredGuests(); } catch (e) { console.error('[db] purge guests failed:', e.message); }
  try { purgeExpiredUserSessions(); } catch (e) { console.error('[db] purge sessions failed:', e.message); }
  try { purgeOldLoginAttempts(30); } catch (e) { console.error('[db] purge login attempts failed:', e.message); }
  try { purgeOldAuditLogs(); } catch (e) { console.error('[db] purge audit logs failed:', e.message); }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS problems (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      text TEXT NOT NULL,
      answer TEXT NOT NULL,
      hints_json TEXT NOT NULL DEFAULT '[]',
      figure_json TEXT,
      image_dataurl TEXT,
      source TEXT NOT NULL DEFAULT 'builtin',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_problems_created_at ON problems(created_at);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'student',
      title TEXT,
      current_problem_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      is_archived INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_role ON chat_sessions(role);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      user_message TEXT,
      ai_message TEXT,
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_turns_role ON chat_turns(role, created_at DESC);

    CREATE TABLE IF NOT EXISTS eval_scores (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      scorer TEXT NOT NULL,
      dimension TEXT NOT NULL,
      value REAL NOT NULL,
      data_type TEXT NOT NULL DEFAULT 'numeric',
      comment TEXT,
      prompt_version_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (turn_id) REFERENCES chat_turns(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_eval_scores_turn ON eval_scores(turn_id);
    CREATE INDEX IF NOT EXISTS idx_eval_scores_session ON eval_scores(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_eval_scores_role ON eval_scores(role, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_eval_scores (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      scorer TEXT NOT NULL,
      dimension TEXT NOT NULL,
      value REAL NOT NULL,
      data_type TEXT NOT NULL DEFAULT 'numeric',
      comment TEXT,
      prompt_version_id TEXT,
      turn_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_eval_scores_session ON session_eval_scores(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_eval_scores_role ON session_eval_scores(role, created_at DESC);

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(role, version)
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_versions_role ON prompt_versions(role, is_active DESC, version DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- ========== 学生记忆系统（P0：情景记忆 + 画像占位）==========
    -- ① 情景记忆：每次答题流水（补上 record_history 过去只存内存、不落库的空缺）
    CREATE TABLE IF NOT EXISTS student_attempts (
      id           TEXT PRIMARY KEY,
      student_id   TEXT NOT NULL DEFAULT 'me',
      session_id   TEXT NOT NULL,
      turn_id      TEXT,
      problem_id   TEXT,
      topic        TEXT,
      user_answer  TEXT,
      correct      INTEGER NOT NULL DEFAULT 0,
      hint_count   INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER,
      error_type   TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- 去重键：同一会话内「同题同答案」只记一次。
    -- persistTurn 自动落库 与 record_history 工具可能同时触发，用 INSERT OR IGNORE 幂等去重。
    CREATE UNIQUE INDEX IF NOT EXISTS uq_attempts_session_problem_answer
      ON student_attempts(session_id, problem_id, user_answer);
    CREATE INDEX IF NOT EXISTS idx_attempts_student_time ON student_attempts(student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attempts_topic        ON student_attempts(student_id, topic);

    -- ② 语义画像：按主题掌握度（规则增量更新，无 LLM）
    CREATE TABLE IF NOT EXISTS topic_mastery (
      student_id TEXT NOT NULL DEFAULT 'me',
      topic      TEXT NOT NULL,
      mastery    REAL NOT NULL DEFAULT 0,   -- 0~1；P0 用正确率近似，时间衰减留待 P1
      attempts   INTEGER NOT NULL DEFAULT 0,
      correct    INTEGER NOT NULL DEFAULT 0,
      last_seen  INTEGER,
      PRIMARY KEY (student_id, topic)
    );

    -- ③ 学生画像：一行一个学生
    CREATE TABLE IF NOT EXISTS student_profile (
      student_id     TEXT PRIMARY KEY DEFAULT 'me',
      level          TEXT,   -- 难度水位：基础/巩固/挑战
      independence   TEXT,   -- 独立性画像
      error_patterns TEXT,   -- JSON: {计算:n, 概念:n, ...}
      preferences    TEXT,   -- JSON: {线段图:true, ...}
      narrative      TEXT,   -- LLM 综述（P1 consolidate 写入），注入 prompt 用
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- ④ 交互记忆：AI 主动记下的零散定性事实
    CREATE TABLE IF NOT EXISTS memory_facts (
      id          TEXT PRIMARY KEY,
      student_id  TEXT NOT NULL DEFAULT 'me',
      kind        TEXT NOT NULL,   -- observation / preference / milestone
      content     TEXT NOT NULL,
      source_turn TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_facts_student ON memory_facts(student_id, created_at DESC);

    -- ========== 用户系统（P0：登录 / 鉴权 / 学生与家长隔离）==========
    -- ① 账号：登录的「人」是谁
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,                 -- uuid
      role          TEXT NOT NULL,                    -- 'student' | 'parent' | 'admin'
      username      TEXT NOT NULL UNIQUE,             -- 登录名
      display_name  TEXT,                             -- 显示名（如"小明"）
      password_hash TEXT NOT NULL,                    -- scrypt：scrypt$salt$hash
      is_admin      INTEGER NOT NULL DEFAULT 0,       -- 家庭管理员：可进管理页
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_login_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- ② 登录态：cookie token → user（服务端会话，登出即失效）
    CREATE TABLE IF NOT EXISTS user_sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      expires_at INTEGER NOT NULL,
      user_agent TEXT,
      ip         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

    -- ③ 家庭关系：家长-孩子绑定（多对多，天然支持爸妈同时绑定）
    CREATE TABLE IF NOT EXISTS family_links (
      parent_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      relation   TEXT,                                -- '父' / '母' / '监护人'
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (parent_id, student_id)
    );

    CREATE INDEX IF NOT EXISTS idx_family_links_student ON family_links(student_id);

    -- ④ 邀请码 / 绑定码：家长生成，孩子注册时凭码自动绑定
    --   kind='register' 孩子注册用（parent_id = 邀请家长）
    --   kind='bind'     已有学生绑定新家长用（target_student_id = 待绑定的学生）
    CREATE TABLE IF NOT EXISTS invite_codes (
      code       TEXT PRIMARY KEY,
      parent_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER,
      used_by    TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_invite_codes_parent ON invite_codes(parent_id);

    -- ========== 用户系统（P2：安全与运营）==========
    -- ⑤ 登录尝试流水：限流依据 + 安全审计
    CREATE TABLE IF NOT EXISTS login_attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT,
      ip         TEXT,
      success    INTEGER NOT NULL DEFAULT 0,
      reason     TEXT,
      user_agent TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(username, ip, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(created_at DESC);

    -- ⑥ 审计日志：谁在什么时候对谁做了什么（含游客/绑定/管理操作）
    CREATE TABLE IF NOT EXISTS audit_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id       TEXT,
      actor_username TEXT,
      actor_role     TEXT,
      action         TEXT NOT NULL,
      target_type    TEXT,
      target_id      TEXT,
      detail         TEXT,
      ip             TEXT,
      user_agent     TEXT,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
  `);

  // Migration: 游客账号到期时间戳（NULL = 正常账号）
  try {
    db.prepare("SELECT guest_expires_at FROM users LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN guest_expires_at INTEGER");
  }

  // Migration: 邀请码通用化（kind / target_student_id）
  try {
    db.prepare("SELECT kind FROM invite_codes LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE invite_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'register'");
  }
  try {
    db.prepare("SELECT target_student_id FROM invite_codes LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE invite_codes ADD COLUMN target_student_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_invite_codes_target ON invite_codes(target_student_id)");

  // Migration: add prompt_version_id to chat_turns if not exists
  try {
    db.prepare("SELECT prompt_version_id FROM chat_turns LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_turns ADD COLUMN prompt_version_id TEXT");
  }

  // Migration: add prompt_version_id to eval_scores if not exists
  try {
    db.prepare("SELECT prompt_version_id FROM eval_scores LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE eval_scores ADD COLUMN prompt_version_id TEXT");
  }

  // Migration: add sdk_session_id to chat_sessions if not exists
  try {
    db.prepare("SELECT sdk_session_id FROM chat_sessions LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT");
  }

  // Migration: 学生记忆系统——工作记忆（长会话压缩摘要）列
  try {
    db.prepare("SELECT context_summary FROM chat_sessions LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN context_summary TEXT");
  }
  try {
    db.prepare("SELECT summary_upto_turn FROM chat_sessions LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN summary_upto_turn INTEGER DEFAULT 0");
  }

  // Migration: 用户系统——会话归属列
  //   user_id    = 谁在用这个会话（决定权限）
  //   student_id = 数据属于谁（决定记忆归属）—— 家长陪孩子做题时两者不同
  try {
    db.prepare("SELECT user_id FROM chat_sessions LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN user_id TEXT");
  }
  try {
    db.prepare("SELECT student_id FROM chat_sessions LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN student_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chat_sessions_student ON chat_sessions(student_id, updated_at DESC)");
}

function seedBuiltinProblems() {
  const count = db.prepare("SELECT COUNT(*) as c FROM problems WHERE source = 'builtin'").get().c;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO problems (id, topic, text, answer, hints_json, figure_json, source)
    VALUES (@id, @topic, @text, @answer, @hints_json, @figure_json, 'builtin')
  `);
  const tx = db.transaction((probs) => {
    for (const p of probs) {
      insert.run({
        id: p.id,
        topic: p.topic,
        text: p.text,
        answer: String(p.answer),
        hints_json: JSON.stringify(p.hints || []),
        figure_json: p.figure ? JSON.stringify(p.figure) : null
      });
    }
  });
  tx(BUILTIN_PROBLEMS);
  console.log(`[db] seeded ${BUILTIN_PROBLEMS.length} builtin problems`);
}

function getAllProblems() {
  getDb();
  const rows = db.prepare("SELECT * FROM problems ORDER BY CASE WHEN source = 'builtin' THEN 0 ELSE 1 END, created_at ASC, id ASC").all();
  return rows.map(rowToProblem);
}

function getProblem(id) {
  getDb();
  const row = db.prepare('SELECT * FROM problems WHERE id = ?').get(id);
  return row ? rowToProblem(row) : null;
}

function insertProblem(problem) {
  getDb();
  const id = problem.id || ('u' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const stmt = db.prepare(`
    INSERT INTO problems (id, topic, text, answer, hints_json, figure_json, image_dataurl, source)
    VALUES (@id, @topic, @text, @answer, @hints_json, @figure_json, @image_dataurl, @source)
  `);
  stmt.run({
    id,
    topic: problem.topic,
    text: problem.text,
    answer: String(problem.answer),
    hints_json: JSON.stringify(problem.hints || []),
    figure_json: problem.figure ? JSON.stringify(problem.figure) : null,
    image_dataurl: problem.imageDataUrl || null,
    source: problem.source || 'ai'
  });
  return getProblem(id);
}

function updateProblemFigure(id, figure, imageDataUrl) {
  getDb();
  db.prepare('UPDATE problems SET figure_json = ?, image_dataurl = ? WHERE id = ?')
    .run(figure ? JSON.stringify(figure) : null, imageDataUrl || null, id);
}

function deleteProblem(id) {
  getDb();
  const info = db.prepare('DELETE FROM problems WHERE id = ?').run(id);
  return info.changes > 0;
}

function rowToProblem(row) {
  const p = {
    id: row.id,
    topic: row.topic,
    text: row.text,
    answer: row.answer,
    hints: JSON.parse(row.hints_json || '[]'),
    source: row.source
  };
  if (row.figure_json) {
    try { p.figure = JSON.parse(row.figure_json); } catch {}
  }
  if (row.image_dataurl) {
    p.imageDataUrl = row.image_dataurl;
  }
  return p;
}

function getProblemsForClient() {
  return getAllProblems().map(p => {
    const { answer, hints, source, imageDataUrl, ...rest } = p;
    if (imageDataUrl) {
      rest.figureImage = imageDataUrl;
    }
    return rest;
  });
}

// ========== Chat Session CRUD ==========

function insertChatSession({ id, role, title, current_problem_id, user_id, student_id }) {
  getDb();
  db.prepare(`
    INSERT INTO chat_sessions (id, role, title, current_problem_id, user_id, student_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, role, title || null, current_problem_id || null, user_id || null, student_id || null);
  return getChatSession(id);
}

function getChatSession(id) {
  getDb();
  const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  return row || null;
}

/**
 * 会话列表。可按 role（模式）过滤；带 owner 时按归属过滤：
 *   - { userId }    只看「我拥有的」会话
 *   - { studentId } 只看「数据属于某学生」的会话（家长看孩子）
 * 无 owner 时返回全部（内部/管理用）。
 */
function listChatSessions(role, { userId, studentId } = {}) {
  getDb();
  const where = ['is_archived = 0'];
  const vals = [];
  if (role) { where.push('role = ?'); vals.push(role); }
  if (userId) { where.push('user_id = ?'); vals.push(userId); }
  if (studentId) { where.push('student_id = ?'); vals.push(studentId); }
  return db.prepare(
    `SELECT * FROM chat_sessions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`
  ).all(...vals);
}

function updateChatSession(id, { title, current_problem_id, is_archived, sdk_session_id, context_summary, summary_upto_turn, user_id, student_id }) {
  getDb();
  const sets = [];
  const vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (current_problem_id !== undefined) { sets.push('current_problem_id = ?'); vals.push(current_problem_id); }
  if (is_archived !== undefined) { sets.push('is_archived = ?'); vals.push(is_archived ? 1 : 0); }
  if (sdk_session_id !== undefined) { sets.push('sdk_session_id = ?'); vals.push(sdk_session_id); }
  if (context_summary !== undefined) { sets.push('context_summary = ?'); vals.push(context_summary); }
  if (summary_upto_turn !== undefined) { sets.push('summary_upto_turn = ?'); vals.push(summary_upto_turn); }
  if (user_id !== undefined) { sets.push('user_id = ?'); vals.push(user_id); }
  if (student_id !== undefined) { sets.push('student_id = ?'); vals.push(student_id); }
  sets.push("updated_at = strftime('%s','now')");
  vals.push(id);
  db.prepare(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteChatSession(id) {
  getDb();
  db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
}

// ========== Chat Turn CRUD ==========

function insertChatTurn({ id, session_id, role, user_message, ai_message, tool_calls_json, input_tokens, output_tokens, duration_ms, error, prompt_version_id }) {
  getDb();
  const turnId = id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO chat_turns (id, session_id, role, user_message, ai_message, tool_calls_json, input_tokens, output_tokens, duration_ms, error, prompt_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    turnId, session_id, role || 'student',
    user_message || null, ai_message || null,
    tool_calls_json || '[]',
    input_tokens || 0, output_tokens || 0, duration_ms || 0,
    error || null,
    prompt_version_id || null
  );
  // 更新 session 的 updated_at
  updateChatSession(session_id, {});
  return turnId;
}

function getChatTurns(session_id) {
  getDb();
  const rows = db.prepare('SELECT * FROM chat_turns WHERE session_id = ? ORDER BY created_at ASC').all(session_id);
  return rows;
}

function getRecentChatTurns(role, limit = 20) {
  getDb();
  const rows = db.prepare('SELECT * FROM chat_turns WHERE role = ? ORDER BY created_at DESC LIMIT ?').all(role, limit);
  return rows.reverse();
}

// ========== Eval Scores CRUD ==========

function insertEvalScore({ id, turn_id, session_id, role, scorer, dimension, value, data_type, comment, prompt_version_id }) {
  getDb();
  const scoreId = id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO eval_scores (id, turn_id, session_id, role, scorer, dimension, value, data_type, comment, prompt_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scoreId, turn_id, session_id, role || 'student',
    scorer, dimension, value,
    data_type || 'numeric', comment || null, prompt_version_id || null
  );
  return scoreId;
}

function getEvalScoresByTurn(turn_id) {
  getDb();
  return db.prepare('SELECT * FROM eval_scores WHERE turn_id = ? ORDER BY created_at ASC').all(turn_id);
}

function getEvalScoresBySession(session_id) {
  getDb();
  return db.prepare('SELECT * FROM eval_scores WHERE session_id = ? ORDER BY created_at ASC').all(session_id);
}

// ========== Session Eval Scores CRUD ==========

function insertSessionEvalScore({ id, session_id, role, scorer, dimension, value, data_type, comment, prompt_version_id, turn_count }) {
  getDb();
  const scoreId = id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO session_eval_scores (id, session_id, role, scorer, dimension, value, data_type, comment, prompt_version_id, turn_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scoreId, session_id, role || 'student',
    scorer, dimension, value,
    data_type || 'numeric', comment || null, prompt_version_id || null,
    turn_count || 0
  );
  return scoreId;
}

function getSessionEvalScores(session_id) {
  getDb();
  return db.prepare('SELECT * FROM session_eval_scores WHERE session_id = ? ORDER BY created_at DESC').all(session_id);
}

function deleteSessionEvalScores(session_id, scorer) {
  getDb();
  if (scorer) {
    db.prepare('DELETE FROM session_eval_scores WHERE session_id = ? AND scorer = ?').run(session_id, scorer);
  } else {
    db.prepare('DELETE FROM session_eval_scores WHERE session_id = ?').run(session_id);
  }
}

function getSessionEvalSummary(role) {
  getDb();
  const params = role ? [role] : [];
  const rows = db.prepare(`
    SELECT ses.dimension, AVG(ses.value) as avg_value, COUNT(*) as count
    FROM session_eval_scores ses
    ${role ? 'WHERE ses.role = ? AND' : 'WHERE'} ses.scorer = 'session-judge'
    GROUP BY ses.dimension
  `).all(...params);

  const evaluatedSessions = db.prepare(`
    SELECT COUNT(DISTINCT ses.session_id) as c
    FROM session_eval_scores ses
    ${role ? 'WHERE ses.role = ? AND' : 'WHERE'} ses.scorer = 'session-judge'
  `).get(...params).c;

  return {
    session_judge_avg: rows.reduce((acc, r) => {
      acc[r.dimension] = Math.round(r.avg_value * 100) / 100;
      return acc;
    }, {}),
    session_judge_count: evaluatedSessions,
  };
}

function getSessionEvalList(role) {
  getDb();
  const params = role ? [role] : [];
  // 获取所有 session 元数据
  const sessions = db.prepare(`
    SELECT id, role, title, current_problem_id, created_at, updated_at, is_archived
    FROM chat_sessions
    ${role ? 'WHERE role = ?' : ''}
    ORDER BY updated_at DESC
  `).all(...params);

  // 获取所有 session_eval_scores，按 session 分组
  const scoresBySession = {};
  const scoreRows = db.prepare(`
    SELECT session_id, scorer, dimension, value, comment, turn_count, created_at
    FROM session_eval_scores
    ${role ? 'WHERE role = ?' : ''}
    ORDER BY created_at DESC
  `).all(...params);

  for (const row of scoreRows) {
    if (!scoresBySession[row.session_id]) scoresBySession[row.session_id] = [];
    scoresBySession[row.session_id].push(row);
  }

  // 获取每个 session 的 turn 数
  const turnCounts = {};
  const turnRows = db.prepare(`
    SELECT session_id, COUNT(*) as count
    FROM chat_turns
    ${role ? 'WHERE role = ?' : ''}
    GROUP BY session_id
  `).all(...params);
  for (const row of turnRows) {
    turnCounts[row.session_id] = row.count;
  }

  return sessions.map(s => {
    const scores = scoresBySession[s.id] || [];
    // 区分 LLM judge 分数和 rule 统计
    const judgeScores = {};
    const ruleStats = {};
    let judgeTurnCount = 0;
    let judgeCreatedAt = null;
    for (const sc of scores) {
      if (sc.scorer === 'session-judge') {
        judgeScores[sc.dimension] = { value: sc.value, comment: sc.comment || '' };
        judgeTurnCount = sc.turn_count;
        judgeCreatedAt = sc.created_at;
      } else if (sc.scorer === 'rule') {
        ruleStats[sc.dimension] = sc.value;
      }
    }
    const hasJudge = Object.keys(judgeScores).length > 0;
    // 计算总均分
    const judgeValues = Object.values(judgeScores).map(v => v.value);
    const overallAvg = judgeValues.length > 0
      ? Math.round((judgeValues.reduce((s, v) => s + v, 0) / judgeValues.length) * 100) / 100
      : null;

    return {
      id: s.id,
      role: s.role,
      title: s.title,
      current_problem_id: s.current_problem_id,
      created_at: s.created_at,
      updated_at: s.updated_at,
      is_archived: s.is_archived,
      turn_count: turnCounts[s.id] || 0,
      has_judge: hasJudge,
      judge_scores: judgeScores,
      rule_stats: ruleStats,
      judge_overall: overallAvg,
      judge_turn_count: judgeTurnCount,
      judge_created_at: judgeCreatedAt,
    };
  });
}

// ========== Student Eval Queries ==========

function getStudentEvalSummary(role) {
  getDb();
  const params = role ? [role] : [];

  // session_eval_scores 中 scorer='student-eval' 的维度均分
  const dimRows = db.prepare(`
    SELECT dimension, AVG(value) as avg_value, COUNT(*) as count
    FROM session_eval_scores
    ${role ? 'WHERE role = ? AND' : 'WHERE'} scorer = 'student-eval'
    GROUP BY dimension
  `).all(...params);

  const evaluatedSessions = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as c
    FROM session_eval_scores
    ${role ? 'WHERE role = ? AND' : 'WHERE'} scorer = 'student-eval'
  `).get(...params).c;

  // 按 topic 统计正确率（从 session_eval_scores 中 dimension='accuracy_by_topic' 的 comment 提取）
  const topicRows = db.prepare(`
    SELECT comment, value
    FROM session_eval_scores
    ${role ? 'WHERE role = ? AND' : 'WHERE'} scorer = 'student-eval' AND dimension = 'accuracy_by_topic'
  `).all(...params);

  const topicStats = {};
  for (const row of topicRows) {
    // comment 格式: "topic_name" 或 "topic:topic_name"
    const topic = row.comment || 'unknown';
    if (!topicStats[topic]) topicStats[topic] = { correct: 0, total: 0 };
    // value 存的是正确数 (0/1)，需要聚合
    // 实际上这里存的是 per-session 的正确率，需要加权
    // 简化处理：直接取平均值
    if (!topicStats[topic].values) topicStats[topic].values = [];
    topicStats[topic].values.push(row.value);
  }

  const topicAccuracy = {};
  for (const [topic, stats] of Object.entries(topicStats)) {
    if (stats.values && stats.values.length > 0) {
      topicAccuracy[topic] = Math.round((stats.values.reduce((s, v) => s + v, 0) / stats.values.length) * 100) / 100;
    }
  }

  // 错误类型分布
  const errorTypeRows = db.prepare(`
    SELECT comment as error_type, COUNT(*) as count
    FROM session_eval_scores
    ${role ? 'WHERE role = ? AND' : 'WHERE'} scorer = 'student-eval' AND dimension = 'error_type'
    GROUP BY comment
  `).all(...params);

  return {
    dimension_avg: dimRows.reduce((acc, r) => {
      acc[r.dimension] = Math.round(r.avg_value * 100) / 100;
      return acc;
    }, {}),
    evaluated_sessions: evaluatedSessions,
    topic_accuracy: topicAccuracy,
    error_type_distribution: errorTypeRows.reduce((acc, r) => {
      acc[r.error_type || 'unknown'] = r.count;
      return acc;
    }, {}),
  };
}

function getStudentEvalList(role) {
  getDb();
  const params = role ? [role] : [];

  const sessions = db.prepare(`
    SELECT id, role, title, current_problem_id, created_at, updated_at
    FROM chat_sessions
    WHERE is_archived = 0 ${role ? 'AND role = ?' : ''}
    ORDER BY updated_at DESC
  `).all(...(role ? [role] : []));

  const scoreRows = db.prepare(`
    SELECT session_id, dimension, value, comment, turn_count, created_at
    FROM session_eval_scores
    ${role ? 'WHERE role = ? AND' : 'WHERE'} scorer = 'student-eval'
    ORDER BY created_at DESC
  `).all(...params);

  const scoresBySession = {};
  for (const row of scoreRows) {
    if (!scoresBySession[row.session_id]) scoresBySession[row.session_id] = [];
    scoresBySession[row.session_id].push(row);
  }

  const turnCounts = {};
  const turnRows = db.prepare(`
    SELECT session_id, COUNT(*) as count
    FROM chat_turns
    ${role ? 'WHERE role = ?' : ''}
    GROUP BY session_id
  `).all(...params);
  for (const row of turnRows) {
    turnCounts[row.session_id] = row.count;
  }

  return sessions.map(s => {
    const scores = scoresBySession[s.id] || [];
    const evalScores = {};
    let evalTurnCount = 0;
    let evalCreatedAt = null;
    for (const sc of scores) {
      if (sc.dimension === 'accuracy_by_topic' || sc.dimension === 'error_type') {
        // 这些是分类维度，存为列表
        if (!evalScores[sc.dimension]) evalScores[sc.dimension] = [];
        evalScores[sc.dimension].push({ value: sc.value, comment: sc.comment });
      } else {
        evalScores[sc.dimension] = { value: sc.value, comment: sc.comment };
      }
      evalTurnCount = sc.turn_count;
      evalCreatedAt = sc.created_at;
    }
    const hasEval = Object.keys(evalScores).length > 0;
    // 计算总均分（排除分类维度）
    const numericDims = ['accuracy', 'independence', 'thinking_quality', 'engagement'];
    const numericValues = numericDims.map(d => evalScores[d]?.value).filter(v => v !== undefined);
    const overallAvg = numericValues.length > 0
      ? Math.round((numericValues.reduce((s, v) => s + v, 0) / numericValues.length) * 100) / 100
      : null;

    return {
      id: s.id,
      role: s.role,
      title: s.title,
      current_problem_id: s.current_problem_id,
      created_at: s.created_at,
      updated_at: s.updated_at,
      turn_count: turnCounts[s.id] || 0,
      has_eval: hasEval,
      eval_scores: evalScores,
      eval_overall: overallAvg,
      eval_turn_count: evalTurnCount,
      eval_created_at: evalCreatedAt,
    };
  });
}

function getEvalDashboard(role) {
  getDb();
  const roleFilter = role ? 'WHERE s.role = ?' : '';
  const params = role ? [role] : [];

  const totalTurns = db.prepare(
    `SELECT COUNT(*) as c FROM chat_turns ${role ? 'WHERE role = ?' : ''}`
  ).get(...(role ? [role] : [])).c;

  const llmJudgeScores = db.prepare(`
    SELECT es.dimension, AVG(es.value) as avg_value, COUNT(*) as count
    FROM eval_scores es
    ${role ? 'WHERE es.role = ? AND' : 'WHERE'} es.scorer = 'llm-judge'
    GROUP BY es.dimension
  `).all(...(role ? [role] : []));

  // 已评估的 turn 数（DISTINCT，而非评分记录总数）
  const evaluatedTurns = db.prepare(`
    SELECT COUNT(DISTINCT es.turn_id) as c
    FROM eval_scores es
    ${role ? 'WHERE es.role = ? AND' : 'WHERE'} es.scorer = 'llm-judge'
  `).get(...(role ? [role] : [])).c;

  // 按 prompt 版本分组的维度均分（关注每次更新 prompt 后评分变化）
  const scoresByPromptVersion = db.prepare(`
    SELECT es.dimension, pv.version as prompt_version, pv.role as prompt_role,
           AVG(es.value) as avg_value, COUNT(*) as count
    FROM eval_scores es
    LEFT JOIN prompt_versions pv ON es.prompt_version_id = pv.id
    ${role ? 'WHERE es.role = ? AND' : 'WHERE'} es.scorer = 'llm-judge'
    GROUP BY es.prompt_version_id, es.dimension
    ORDER BY pv.role, pv.version
  `).all(...(role ? [role] : []));

  // Token 聚合数据
  const tokenStats = db.prepare(`
    SELECT
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      AVG(input_tokens) as avg_input_tokens,
      AVG(output_tokens) as avg_output_tokens,
      COUNT(*) as turn_count
    FROM chat_turns
    ${role ? 'WHERE role = ?' : ''}
  `).get(...(role ? [role] : []));

  // 按 prompt 版本分组的 token 消耗
  const tokensByPromptVersion = db.prepare(`
    SELECT pv.version as prompt_version, pv.role as prompt_role,
           SUM(t.input_tokens) as total_input_tokens,
           SUM(t.output_tokens) as total_output_tokens,
           COUNT(*) as turn_count
    FROM chat_turns t
    LEFT JOIN prompt_versions pv ON t.prompt_version_id = pv.id
    ${role ? 'WHERE t.role = ?' : ''}
    GROUP BY t.prompt_version_id
    ORDER BY pv.role, pv.version
  `).all(...(role ? [role] : []));

  const recentTurns = db.prepare(`
    SELECT t.id, t.session_id, t.role, t.user_message, t.ai_message,
           t.tool_calls_json, t.duration_ms, t.error, t.created_at,
           t.input_tokens, t.output_tokens,
           t.prompt_version_id, pv.version as prompt_version,
           (SELECT GROUP_CONCAT(es.dimension || ':' || es.value || ':' || COALESCE(es.comment,''), '||')
            FROM eval_scores es WHERE es.turn_id = t.id AND es.scorer = 'llm-judge') as llm_scores,
           (SELECT GROUP_CONCAT(es.dimension || ':' || es.value, '||')
            FROM eval_scores es WHERE es.turn_id = t.id AND es.scorer = 'rule') as rule_scores
    FROM chat_turns t
    LEFT JOIN prompt_versions pv ON t.prompt_version_id = pv.id
    ${role ? 'WHERE t.role = ?' : ''}
    ORDER BY t.created_at DESC
    LIMIT 50
  `).all(...(role ? [role] : []));

  return {
    total_turns: totalTurns,
    llm_judge_avg: llmJudgeScores.reduce((acc, s) => {
      acc[s.dimension] = Math.round(s.avg_value * 100) / 100;
      return acc;
    }, {}),
    llm_judge_count: evaluatedTurns,
    scores_by_prompt_version: scoresByPromptVersion.reduce((acc, row) => {
      const rolePrefix = row.prompt_role || 'unknown';
      const key = row.prompt_version ? `${rolePrefix}_v${row.prompt_version}` : `${rolePrefix}_unversioned`;
      if (!acc[key]) acc[key] = { prompt_version: row.prompt_version, prompt_role: row.prompt_role, dims: {}, count: 0 };
      acc[key].dims[row.dimension] = Math.round(row.avg_value * 100) / 100;
      acc[key].count += row.count;
      return acc;
    }, {}),
    token_stats: {
      total_input_tokens: tokenStats?.total_input_tokens || 0,
      total_output_tokens: tokenStats?.total_output_tokens || 0,
      avg_input_tokens: tokenStats?.avg_input_tokens ? Math.round(tokenStats.avg_input_tokens) : 0,
      avg_output_tokens: tokenStats?.avg_output_tokens ? Math.round(tokenStats.avg_output_tokens) : 0,
      turn_count: tokenStats?.turn_count || 0,
    },
    tokens_by_prompt_version: tokensByPromptVersion.map(row => ({
      prompt_version: row.prompt_version,
      prompt_role: row.prompt_role,
      total_input_tokens: row.total_input_tokens || 0,
      total_output_tokens: row.total_output_tokens || 0,
      total_tokens: (row.total_input_tokens || 0) + (row.total_output_tokens || 0),
      turn_count: row.turn_count,
    })),
    recent_turns: recentTurns,
  };
}

export function getEvalTurns(page = 1, pageSize = 20, role) {
  getDb();
  const offset = (page - 1) * pageSize;

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM chat_turns ${role ? 'WHERE role = ?' : ''}`
  ).get(...(role ? [role] : [])).c;

  const turns = db.prepare(`
    SELECT t.id, t.session_id, t.role, t.user_message, t.ai_message,
           t.tool_calls_json, t.duration_ms, t.error, t.created_at,
           t.input_tokens, t.output_tokens,
           t.prompt_version_id, pv.version as prompt_version,
           (SELECT GROUP_CONCAT(es.dimension || ':' || es.value || ':' || COALESCE(es.comment,''), '||')
            FROM eval_scores es WHERE es.turn_id = t.id AND es.scorer = 'llm-judge') as llm_scores,
           (SELECT GROUP_CONCAT(es.dimension || ':' || es.value, '||')
            FROM eval_scores es WHERE es.turn_id = t.id AND es.scorer = 'rule') as rule_scores
    FROM chat_turns t
    LEFT JOIN prompt_versions pv ON t.prompt_version_id = pv.id
    ${role ? 'WHERE t.role = ?' : ''}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...(role ? [role] : []), pageSize, offset);

  return {
    turns,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize) || 1,
  };
}

// ========== Prompt Version CRUD ==========

function insertPromptVersion({ role, content, description }) {
  getDb();
  const id = crypto.randomUUID();
  // 获取当前最大版本号
  const row = db.prepare('SELECT MAX(version) as max_v FROM prompt_versions WHERE role = ?').get(role);
  const version = (row?.max_v || 0) + 1;
  // 插入新版本
  db.prepare(`
    INSERT INTO prompt_versions (id, role, version, content, description, is_active)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(id, role, version, content, description || null);
  return { id, role, version };
}

function activatePromptVersion(id) {
  getDb();
  const row = db.prepare('SELECT role FROM prompt_versions WHERE id = ?').get(id);
  if (!row) return false;
  const tx = db.transaction(() => {
    db.prepare('UPDATE prompt_versions SET is_active = 0 WHERE role = ?').run(row.role);
    db.prepare('UPDATE prompt_versions SET is_active = 1 WHERE id = ?').run(id);
  });
  tx();
  return true;
}

function getActivePromptVersion(role) {
  getDb();
  const row = db.prepare('SELECT * FROM prompt_versions WHERE role = ? AND is_active = 1').get(role);
  return row || null;
}

function listPromptVersions(role) {
  getDb();
  const rows = role
    ? db.prepare('SELECT * FROM prompt_versions WHERE role = ? ORDER BY version DESC').all(role)
    : db.prepare('SELECT * FROM prompt_versions ORDER BY role, version DESC').all();
  return rows;
}

function getPromptVersion(id) {
  getDb();
  return db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(id) || null;
}

function listPromptRoles() {
  getDb();
  return db.prepare('SELECT DISTINCT role FROM prompt_versions ORDER BY role').all().map(r => r.role);
}

function deletePromptVersion(id) {
  getDb();
  const row = db.prepare('SELECT role, is_active FROM prompt_versions WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'not found' };

  // 不允许删除当前活跃版本（避免该角色无可用 prompt）
  if (row.is_active) {
    return { ok: false, error: '不能删除正在使用的活跃版本，请先激活其他版本再删除' };
  }

  db.prepare('DELETE FROM prompt_versions WHERE id = ?').run(id);
  return { ok: true, role: row.role };
}

// ========== Settings（运行时配置，管理页可改）==========

// 读取全部设置项，返回 [{ key, value, updated_at }]
function getAllSettings() {
  getDb();
  return db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all();
}

// 读取单个设置项，不存在返回 null
function getSetting(key) {
  getDb();
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

// 新增或更新设置项
function upsertSetting(key, value) {
  getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s','now')
  `).run(key, value);
}

// 删除设置项（恢复使用 .env / 环境变量）
function deleteSetting(key) {
  getDb();
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ========== Student Memory CRUD（学生记忆系统）==========

const DEFAULT_STUDENT_ID = 'me';

function safeJsonParse(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * 记录一次答题（确定性，无 LLM）：
 *   插入一行 student_attempts + 增量更新 topic_mastery。
 * 去重：同一会话内「同题同答案」只记一次（persistTurn 自动落库与 record_history 工具可能重复触发）。
 * 返回 { inserted, id }；inserted=false 表示命中去重、未写入、也未更新掌握度。
 */
function recordAttempt({ id, student_id, session_id, turn_id, problem_id, topic, user_answer, correct, hint_count, duration_ms, error_type }) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const attemptId = id || crypto.randomUUID();
  const info = db.prepare(`
    INSERT OR IGNORE INTO student_attempts
      (id, student_id, session_id, turn_id, problem_id, topic, user_answer, correct, hint_count, duration_ms, error_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId, sid, session_id, turn_id ?? null, problem_id ?? null, topic ?? null,
    user_answer ?? null, correct ? 1 : 0, hint_count || 0, duration_ms ?? null, error_type ?? null
  );
  if (info.changes > 0) {
    if (topic) bumpTopicMastery(sid, topic, !!correct);
  } else if (turn_id && problem_id != null && user_answer != null) {
    // 命中去重（通常是 record_history 工具先写入、turn_id 为空）：
    // 由随后的 persistTurn 自动落库回填 turn_id，便于把答题流水追溯回具体 turn。
    db.prepare(`
      UPDATE student_attempts SET turn_id = ?
      WHERE session_id = ? AND problem_id = ? AND user_answer = ? AND turn_id IS NULL
    `).run(turn_id, session_id, problem_id, user_answer);
  }
  return { inserted: info.changes > 0, id: attemptId };
}

/**
 * 增量更新某主题的掌握度（P1：带时间衰减）。
 *   1. 读取该主题现有掌握度，按「距上次作答的时间」做指数衰减（半衰期 MASTERY_HALFLIFE_DAYS 天）；
 *   2. 用学习率 α 把本次作答结果（0/1）融合进去：mastery = prior + α·(outcome − prior)；
 *   3. 累加 attempts / correct，刷新 last_seen。
 * 首次作答直接用 outcome 作为掌握度。
 */
function bumpTopicMastery(student_id, topic, correct) {
  getDb();
  const now = Math.floor(Date.now() / 1000);
  const outcome = correct ? 1 : 0;
  const row = db.prepare(
    'SELECT mastery, attempts, correct, last_seen FROM topic_mastery WHERE student_id = ? AND topic = ?'
  ).get(student_id, topic);

  if (!row) {
    db.prepare(`
      INSERT INTO topic_mastery (student_id, topic, mastery, attempts, correct, last_seen)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(student_id, topic, outcome, outcome, now);
    return;
  }

  const prior = decayedMastery(row.mastery, row.last_seen, now);
  const mastery = prior + MASTERY_LEARNING_RATE * (outcome - prior);
  db.prepare(`
    UPDATE topic_mastery
    SET mastery = ?, attempts = attempts + 1, correct = correct + ?, last_seen = ?
    WHERE student_id = ? AND topic = ?
  `).run(mastery, outcome, now, student_id, topic);
}

// 把掌握度按「距 now 的时长」做指数衰减（无 last_seen 或时间未前进则不衰减）
function decayedMastery(mastery, lastSeen, now) {
  const m = Number(mastery) || 0;
  if (!lastSeen) return m;
  const elapsedDays = (now - Number(lastSeen)) / 86400;
  if (elapsedDays <= 0) return m;
  const halfLife = MASTERY_HALFLIFE_DAYS > 0 ? MASTERY_HALFLIFE_DAYS : 21;
  return m * Math.pow(0.5, elapsedDays / halfLife);
}

/**
 * 批量刷新该学生所有主题的掌握度衰减（不新增作答，仅随时间"遗忘"）。
 * 由 consolidate 定期调用：让长期未练的主题掌握度自然回落，避免"吃老本"。
 * 返回被更新的主题数。
 */
function applyMasteryDecay(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    'SELECT topic, mastery, last_seen FROM topic_mastery WHERE student_id = ?'
  ).all(sid);
  const upd = db.prepare('UPDATE topic_mastery SET mastery = ? WHERE student_id = ? AND topic = ?');
  let n = 0;
  const tx = db.transaction((rs) => {
    for (const r of rs) {
      const decayed = decayedMastery(r.mastery, r.last_seen, now);
      if (decayed !== (Number(r.mastery) || 0)) {
        upd.run(decayed, sid, r.topic);
        n++;
      }
    }
  });
  tx(rows);
  return n;
}

/**
 * 答题总量统计（用于 consolidate 触发门控 / 画像输入）。
 */
function getAttemptStats(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(correct), 0) AS correct,
           MAX(created_at) AS last_at
    FROM student_attempts WHERE student_id = ?
  `).get(sid);
  return { total: row.total || 0, correct: row.correct || 0, last_at: row.last_at || null };
}

function getTopicMastery(student_id, { minAttempts = 0 } = {}) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare(`
    SELECT topic, mastery, attempts, correct, last_seen
    FROM topic_mastery
    WHERE student_id = ? AND attempts >= ?
    ORDER BY attempts DESC, last_seen DESC
  `).all(sid, minAttempts);
}

function getRecentAttempts(student_id, limit = 50) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare(`
    SELECT id, session_id, turn_id, problem_id, topic, user_answer, correct, hint_count, duration_ms, error_type, created_at
    FROM student_attempts
    WHERE student_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(sid, limit);
}

function getAttemptsByTopic(student_id, topic, limit = 10) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare(`
    SELECT id, session_id, turn_id, problem_id, topic, user_answer, correct, hint_count, created_at
    FROM student_attempts
    WHERE student_id = ? AND topic = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(sid, topic, limit);
}

function getStudentProfile(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const row = db.prepare('SELECT * FROM student_profile WHERE student_id = ?').get(sid);
  if (!row) return null;
  return {
    student_id: row.student_id,
    level: row.level,
    independence: row.independence,
    error_patterns: safeJsonParse(row.error_patterns, null),
    preferences: safeJsonParse(row.preferences, null),
    narrative: row.narrative,
    updated_at: row.updated_at,
  };
}

// 仅在传入非 undefined 时覆盖对应字段（便于增量更新）
function upsertStudentProfile({ student_id, level, independence, error_patterns, preferences, narrative }) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const toJson = (v) => (v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
  db.prepare(`
    INSERT INTO student_profile (student_id, level, independence, error_patterns, preferences, narrative, updated_at)
    VALUES (@sid, @level, @ind, @ep, @pref, @narr, strftime('%s','now'))
    ON CONFLICT(student_id) DO UPDATE SET
      level          = COALESCE(excluded.level, level),
      independence   = COALESCE(excluded.independence, independence),
      error_patterns = COALESCE(excluded.error_patterns, error_patterns),
      preferences    = COALESCE(excluded.preferences, preferences),
      narrative      = COALESCE(excluded.narrative, narrative),
      updated_at     = strftime('%s','now')
  `).run({
    sid,
    level: level === undefined ? null : level,
    ind: independence === undefined ? null : independence,
    ep: toJson(error_patterns),
    pref: toJson(preferences),
    narr: narrative === undefined ? null : narrative,
  });
  return getStudentProfile(sid);
}

function insertMemoryFact({ id, student_id, kind, content, source_turn }) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const fid = id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO memory_facts (id, student_id, kind, content, source_turn)
    VALUES (?, ?, ?, ?, ?)
  `).run(fid, sid, kind || 'observation', content, source_turn ?? null);
  return fid;
}

function getMemoryFacts(student_id, limit = 20) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare(`
    SELECT id, kind, content, source_turn, created_at
    FROM memory_facts
    WHERE student_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(sid, limit);
}

/**
 * 按「天」聚合正确率（成长曲线用）。返回 [{ day:'YYYY-MM-DD', total, correct, rate }]，按日期升序。
 * @param {string} student_id
 * @param {number} days - 只取最近 N 天
 */
function getDailyAccuracy(student_id, days = 30) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare(`
    SELECT date(created_at, 'unixepoch', 'localtime') AS day,
           COUNT(*) AS total,
           COALESCE(SUM(correct), 0) AS correct
    FROM student_attempts
    WHERE student_id = ? AND created_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(sid, since);
  return rows.map((r) => ({
    day: r.day,
    total: r.total,
    correct: r.correct,
    rate: r.total ? Math.round((r.correct / r.total) * 100) : 0,
  }));
}

/**
 * 错因分布（仅统计答错且有 error_type 的答题）。返回 [{ error_type, count }]，按次数降序。
 */
function getErrorTypeDistribution(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare(`
    SELECT error_type, COUNT(*) AS count
    FROM student_attempts
    WHERE student_id = ? AND correct = 0 AND error_type IS NOT NULL AND error_type <> ''
    GROUP BY error_type
    ORDER BY count DESC
  `).all(sid);
}

// ========== 用户系统 CRUD ==========

// 对外返回的用户对象：剥离 password_hash（永不出网关）
function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    username: row.username,
    display_name: row.display_name,
    is_admin: !!row.is_admin,
    status: row.status,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    guest_expires_at: row.guest_expires_at || null,
    is_guest: !!row.guest_expires_at,
  };
}

function createUser({ id, role, username, display_name, password_hash, is_admin = 0, guest_expires_at = null }) {
  getDb();
  const uid = id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO users (id, role, username, display_name, password_hash, is_admin, guest_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uid, role || 'student', username, display_name || null, password_hash, is_admin ? 1 : 0, guest_expires_at || null);
  return getUserById(uid);
}

function getUserById(id) {
  getDb();
  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

// 内部用：含 password_hash，仅供登录校验
function getUserRowByUsername(username) {
  getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getUserByUsername(username) {
  return sanitizeUser(getUserRowByUsername(username));
}

function touchUserLogin(id) {
  getDb();
  db.prepare("UPDATE users SET last_login_at = strftime('%s','now') WHERE id = ?").run(id);
}

function listUsers(role) {
  getDb();
  const rows = role
    ? db.prepare('SELECT * FROM users WHERE role = ? ORDER BY created_at ASC').all(role)
    : db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  return rows.map(sanitizeUser);
}

// ---------- 登录态 ----------

function insertUserSession({ token, user_id, expires_at, user_agent, ip }) {
  getDb();
  db.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, user_agent, ip)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, user_id, expires_at, user_agent || null, ip || null);
}

/**
 * 用令牌换用户（校验过期）。家长附带 children（已绑定的孩子），
 * 供鉴权中间件与前端账户菜单直接使用。
 */
function getUserByToken(token) {
  if (!token) return null;
  getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(`
    SELECT u.* FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'
  `).get(token, now);
  if (!row) return null;
  const user = sanitizeUser(row);
  user.children = row.role === 'parent' ? listChildren(row.id) : [];
  return user;
}

function deleteUserSession(token) {
  getDb();
  db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
}

function deleteUserSessionsOfUser(user_id, exceptToken = null) {
  getDb();
  if (exceptToken) {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND token <> ?').run(user_id, exceptToken);
  } else {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(user_id);
  }
}

function purgeExpiredUserSessions() {
  getDb();
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now);
  return info.changes;
}

// ---------- 账号管理（P2：改密 / 启停 / 管理员 / 删除）----------

/** 账号数量（可按角色过滤） */
function countUsers(role) {
  getDb();
  return role
    ? db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(role).c
    : db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

/** 管理员数量（用于「不能移除最后一个管理员」的保护） */
function countAdmins() {
  getDb();
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND status = 'active'").get().c;
}

/** 改密（只写哈希；调用方负责重新下发/踢会话） */
function updateUserPassword(id, password_hash) {
  getDb();
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
  return info.changes > 0;
}

function setUserStatus(id, status) {
  getDb();
  const info = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  return info.changes > 0;
}

function setUserAdmin(id, isAdmin) {
  getDb();
  const info = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  return info.changes > 0;
}

function setUserDisplayName(id, display_name) {
  getDb();
  const info = db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name || null, id);
  return info.changes > 0;
}

/**
 * 删除账号并清掉它的数据（会话 / 记忆 / 登录态 / 家庭关系）。
 * 不删 problems（题库是共享的）。用于管理页删账号与游客到期清理。
 */
function deleteUser(id) {
  getDb();
  const tx = db.transaction((uid) => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM chat_turns WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = ? OR student_id = ?)').run(uid, uid);
    db.prepare('DELETE FROM chat_sessions WHERE user_id = ? OR student_id = ?').run(uid, uid);
    db.prepare('DELETE FROM student_attempts WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM topic_mastery WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM student_profile WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM memory_facts WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM family_links WHERE parent_id = ? OR student_id = ?').run(uid, uid);
    db.prepare('DELETE FROM invite_codes WHERE parent_id = ? OR target_student_id = ?').run(uid, uid);
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    return info.changes > 0;
  });
  return tx(id);
}

/**
 * 账号列表（含运营统计）：会话数、绑定孩子数、答题数、最后活跃。
 * 供管理页 accounts.html 使用。
 */
function listUsersWithStats() {
  getDb();
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  const sessStmt = db.prepare('SELECT COUNT(*) AS c FROM chat_sessions WHERE user_id = ?');
  const childStmt = db.prepare('SELECT COUNT(*) AS c FROM family_links WHERE parent_id = ?');
  const parentStmt = db.prepare('SELECT COUNT(*) AS c FROM family_links WHERE student_id = ?');
  const attemptStmt = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(correct),0) AS ok FROM student_attempts WHERE student_id = ?');
  return rows.map((row) => {
    const u = sanitizeUser(row);
    u.session_count = sessStmt.get(row.id).c;
    u.child_count = childStmt.get(row.id).c;
    u.parent_count = parentStmt.get(row.id).c;
    const a = attemptStmt.get(row.id);
    u.attempt_count = a.c;
    u.correct_count = a.ok;
    return u;
  });
}

/** 家长绑定的孩子数（用于 requireParentOf 之外的展示） */
function countChildrenOf(parent_id) {
  getDb();
  return db.prepare('SELECT COUNT(*) AS c FROM family_links WHERE parent_id = ?').get(parent_id).c;
}

// ---------- 登录限流 ----------

function recordLoginAttempt({ username, ip, success, reason, user_agent }) {
  getDb();
  db.prepare(`
    INSERT INTO login_attempts (username, ip, success, reason, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(username || null, ip || null, success ? 1 : 0, reason || null, (user_agent || '').slice(0, 255) || null);
}

/**
 * 统计窗口内的失败次数，两个维度分开：
 *   - by_user_ip：同一「用户名 + IP」的失败数 —— 主防线，防单账号被爆破
 *   - by_ip     ：同一 IP 跨所有用户名的失败数 —— 次防线，防撞库式喷洒
 * 两者阈值不同（后者更宽松），避免同一出口 IP 下的正常用户被误伤。
 * @returns {{ by_user_ip:number, by_ip:number }}
 */
function countRecentFailedAttempts({ username, ip, windowSeconds }) {
  getDb();
  const since = Math.floor(Date.now() / 1000) - Math.max(1, windowSeconds);
  const byUserIp = (username && ip)
    ? db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND ip = ? AND success = 0 AND created_at >= ?').get(username, ip, since).c
    : (username
      ? db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND success = 0 AND created_at >= ?').get(username, since).c
      : 0);
  const byIp = ip
    ? db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND success = 0 AND created_at >= ?').get(ip, since).c
    : 0;
  return { by_user_ip: byUserIp, by_ip: byIp };
}

/** 清理过期的登录尝试流水（启动时调用） */
function purgeOldLoginAttempts(days = 30) {
  getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, days) * 86400;
  return db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(cutoff).changes;
}

// ---------- 审计日志 ----------

function insertAuditLog({ actor_id, actor_username, actor_role, action, target_type, target_id, detail, ip, user_agent }) {
  getDb();
  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_username, actor_role, action, target_type, target_id, detail, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actor_id || null,
    actor_username || null,
    actor_role || null,
    action,
    target_type || null,
    target_id || null,
    detail ? String(detail).slice(0, 500) : null,
    ip || null,
    (user_agent || '').slice(0, 255) || null,
  );
}

function listAuditLogs({ limit = 100, action = null, actor_id = null } = {}) {
  getDb();
  const where = [];
  const vals = [];
  if (action) { where.push('action = ?'); vals.push(action); }
  if (actor_id) { where.push('actor_id = ?'); vals.push(actor_id); }
  const sql = `SELECT * FROM audit_logs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, Math.max(1, Math.min(500, limit)));
}

function purgeOldAuditLogs(days = AUDIT_RETENTION_DAYS) {
  getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(1, days) * 86400;
  return db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff).changes;
}

// ---------- 孩子数据统计（家长页用）----------

/** 某学生的档案概览：会话数 / 答题数 / 正确率 / 精通主题数 / 最后活跃 */
function getChildStats(student_id) {
  getDb();
  const sessions = db.prepare('SELECT COUNT(*) AS c, MAX(updated_at) AS last FROM chat_sessions WHERE student_id = ?').get(student_id);
  const att = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(correct),0) AS ok, MAX(created_at) AS last FROM student_attempts WHERE student_id = ?').get(student_id);
  const topics = db.prepare('SELECT COUNT(*) AS c FROM topic_mastery WHERE student_id = ?').get(student_id);
  const mastery = db.prepare('SELECT AVG(mastery) AS avg FROM topic_mastery WHERE student_id = ?').get(student_id);
  const profile = getStudentProfile(student_id);
  return {
    student_id,
    session_count: sessions.c,
    attempt_count: att.c,
    correct_count: att.ok,
    rate: att.c ? Math.round((att.ok / att.c) * 100) : 0,
    topic_count: topics.c,
    avg_mastery: mastery.avg == null ? null : Math.round(mastery.avg * 100),
    level: profile ? profile.level : null,
    last_active: Math.max(sessions.last || 0, att.last || 0) || null,
  };
}

// ---------- 游客试用 ----------

/** 游客账号是否是同一批（按 created_at 命名，便于识别） */
function listExpiredGuests(nowSec = Math.floor(Date.now() / 1000)) {
  getDb();
  return db.prepare(`
    SELECT id, username, display_name, created_at, guest_expires_at
    FROM users
    WHERE guest_expires_at IS NOT NULL AND guest_expires_at <= ?
  `).all(nowSec);
}

/**
 * 清理到期游客账号（连同其会话与记忆）。
 * 启动时调用一次；也可由定时任务定期调用。
 * @returns {{removed:number, ids:string[]}}
 */
function purgeExpiredGuests(nowSec = Math.floor(Date.now() / 1000)) {
  const expired = listExpiredGuests(nowSec);
  for (const g of expired) {
    try {
      deleteUser(g.id);
    } catch (e) {
      console.error(`[db] purge guest ${g.username} failed:`, e.message);
    }
  }
  if (expired.length) {
    console.log(`[db] 已清理 ${expired.length} 个到期游客账号：${expired.map((g) => g.username).join(', ')}`);
  }
  return { removed: expired.length, ids: expired.map((g) => g.id) };
}

/** 生成唯一的游客用户名（guest_ + 8 位随机）；冲突则重试 */
function nextGuestUsername() {
  getDb();
  for (let i = 0; i < 20; i++) {
    const name = GUEST_USERNAME_PREFIX + crypto.randomBytes(4).toString('hex');
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return name;
  }
  return GUEST_USERNAME_PREFIX + crypto.randomUUID().slice(0, 8);
}

// ---------- 家庭关系 ----------

function linkParentChild(parent_id, student_id, relation = null) {
  getDb();
  db.prepare(`
    INSERT INTO family_links (parent_id, student_id, relation)
    VALUES (?, ?, ?)
    ON CONFLICT(parent_id, student_id) DO NOTHING
  `).run(parent_id, student_id, relation || null);
}

function listChildren(parent_id) {
  getDb();
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, f.relation, f.created_at AS linked_at
    FROM family_links f
    JOIN users u ON u.id = f.student_id
    WHERE f.parent_id = ?
    ORDER BY f.created_at ASC
  `).all(parent_id);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    relation: r.relation,
    linked_at: r.linked_at,
  }));
}

function isBoundChild(parent_id, student_id) {
  if (!parent_id || !student_id) return false;
  getDb();
  const row = db.prepare(
    'SELECT 1 AS ok FROM family_links WHERE parent_id = ? AND student_id = ?'
  ).get(parent_id, student_id);
  return !!row;
}

function unlinkParentChild(parent_id, student_id) {
  getDb();
  db.prepare('DELETE FROM family_links WHERE parent_id = ? AND student_id = ?').run(parent_id, student_id);
}

// ---------- 邀请码 ----------

/**
 * 建码。
 *   kind='register'（默认）：孩子注册用，parent_id = 邀请的家长
 *   kind='bind'：第二位家长绑定已有学生用，target_student_id 指向该学生
 */
function createInviteCode({ code, parent_id, expires_at, kind = 'register', target_student_id = null }) {
  getDb();
  db.prepare(`
    INSERT INTO invite_codes (code, parent_id, expires_at, kind, target_student_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, parent_id, expires_at || null, kind, target_student_id || null);
  return code;
}

function getInviteCode(code) {
  getDb();
  return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) || null;
}

function listInviteCodes(parent_id) {
  getDb();
  return db.prepare(
    'SELECT * FROM invite_codes WHERE parent_id = ? ORDER BY created_at DESC'
  ).all(parent_id);
}

/** 某学生可被绑定的码（kind='bind' 且未使用） */
function listBindCodesOfStudent(student_id) {
  getDb();
  return db.prepare(`
    SELECT * FROM invite_codes
    WHERE target_student_id = ? AND kind = 'bind'
    ORDER BY created_at DESC
  `).all(student_id);
}

/**
 * 核销码。成功返回码行信息，失败（不存在/已用/过期）返回 null。
 * @param {string} code
 * @param {string} usedBy 核销人 id（register 流程里是新生；bind 流程里是新绑定的家长）
 */
function redeemInviteCode(code, usedBy) {
  getDb();
  const row = getInviteCode(code);
  if (!row) return null;
  if (row.used_by) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at <= now) return null;
  const info = db.prepare(
    'UPDATE invite_codes SET used_by = ? WHERE code = ? AND used_by IS NULL'
  ).run(usedBy, code);
  if (!info.changes) return null;
  return row;
}

// ---------- 引导账号 + 历史数据承接 ----------

/**
 * 首次启动（users 表为空）时创建引导学生账号，
 * 并把现网匿名历史（student_id='me' 的记忆行、user_id 为空的旧会话）改挂到它名下。
 * 只跑一次：之后 users 非空即直接返回。
 */
function seedBootstrapUser() {
  getDb();
  // 只统计正式账号（游客不算），避免库中只剩游客时引导账号缺席
  const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE guest_expires_at IS NULL').get().c;
  if (count > 0) return;

  let username = BOOTSTRAP_STUDENT_USERNAME;
  // 极端情况：库里已有同名（理论不会，count=0 时）——加后缀兜底
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    username = `${username}_${Date.now().toString(36)}`;
  }

  const uid = crypto.randomUUID();
  db.prepare(`
    INSERT INTO users (id, role, username, display_name, password_hash, is_admin)
    VALUES (?, 'student', ?, ?, ?, 1)
  `).run(uid, username, '示例学生', hashPassword(BOOTSTRAP_STUDENT_PASSWORD));

  migrateLegacyOwnership(uid);
  console.log(`[db] 已创建引导学生账号 ${username}（密码见 BOOTSTRAP_STUDENT_PASSWORD），历史数据已挂到该账号`);
}

/** 把匿名历史（'me' 与无归属会话）改挂到指定账号 */
function migrateLegacyOwnership(uid) {
  getDb();
  const now = Math.floor(Date.now() / 1000);
  const stats = {};
  for (const table of ['student_attempts', 'topic_mastery', 'memory_facts']) {
    const info = db.prepare(`UPDATE ${table} SET student_id = ? WHERE student_id = ?`).run(uid, DEFAULT_STUDENT_ID);
    stats[table] = info.changes;
  }
  // student_profile：主键是 student_id，用「行存在则改写主键」的方式平移
  try {
    const legacy = db.prepare('SELECT * FROM student_profile WHERE student_id = ?').get(DEFAULT_STUDENT_ID);
    if (legacy) {
      db.prepare(`
        INSERT INTO student_profile (student_id, level, independence, error_patterns, preferences, narrative, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(student_id) DO NOTHING
      `).run(uid, legacy.level, legacy.independence, legacy.error_patterns, legacy.preferences, legacy.narrative, legacy.updated_at || now);
      db.prepare('DELETE FROM student_profile WHERE student_id = ?').run(DEFAULT_STUDENT_ID);
      stats.student_profile = 1;
    }
  } catch (e) {
    console.error('[db] migrate student_profile failed:', e.message);
  }
  // 旧会话：无归属的挂到引导账号
  const s1 = db.prepare('UPDATE chat_sessions SET user_id = ? WHERE user_id IS NULL').run(uid);
  const s2 = db.prepare('UPDATE chat_sessions SET student_id = ? WHERE student_id IS NULL').run(uid);
  stats.chat_sessions = s1.changes;
  stats.chat_sessions_total = s2.changes;
  console.log('[db] 历史数据迁移：', JSON.stringify(stats));
  return stats;
}

// ========== Prompt Seed ==========

function seedPromptVersions() {
  getDb();
  const count = db.prepare("SELECT COUNT(*) as c FROM prompt_versions").get().c;
  if (count > 0) return;

  for (const seed of SEED_PROMPTS) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO prompt_versions (id, role, version, content, description, is_active)
      VALUES (?, ?, 1, ?, ?, 1)
    `).run(id, seed.role, seed.content, seed.description);
  }
  console.log('[db] seeded prompt_versions with initial prompts');
}

export {
  getDb,
  getAllProblems,
  getProblem,
  insertProblem,
  updateProblemFigure,
  deleteProblem,
  getProblemsForClient,
  insertChatSession,
  getChatSession,
  listChatSessions,
  updateChatSession,
  deleteChatSession,
  insertChatTurn,
  getChatTurns,
  getRecentChatTurns,
  insertEvalScore,
  getEvalScoresByTurn,
  getEvalScoresBySession,
  getEvalDashboard,
  insertSessionEvalScore,
  getSessionEvalScores,
  deleteSessionEvalScores,
  getSessionEvalSummary,
  getSessionEvalList,
  getStudentEvalSummary,
  getStudentEvalList,
  insertPromptVersion,
  activatePromptVersion,
  getActivePromptVersion,
  listPromptVersions,
  getPromptVersion,
  listPromptRoles,
  deletePromptVersion,
  seedPromptVersions,
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
  // Student Memory
  recordAttempt,
  bumpTopicMastery,
  applyMasteryDecay,
  getAttemptStats,
  getTopicMastery,
  getRecentAttempts,
  getAttemptsByTopic,
  getStudentProfile,
  upsertStudentProfile,
  insertMemoryFact,
  getMemoryFacts,
  getDailyAccuracy,
  getErrorTypeDistribution,
  // 用户系统
  sanitizeUser,
  createUser,
  getUserById,
  getUserByUsername,
  getUserRowByUsername,
  touchUserLogin,
  listUsers,
  listUsersWithStats,
  countUsers,
  countAdmins,
  updateUserPassword,
  setUserStatus,
  setUserAdmin,
  setUserDisplayName,
  deleteUser,
  insertUserSession,
  getUserByToken,
  deleteUserSession,
  deleteUserSessionsOfUser,
  purgeExpiredUserSessions,
  linkParentChild,
  listChildren,
  isBoundChild,
  unlinkParentChild,
  countChildrenOf,
  createInviteCode,
  getInviteCode,
  listInviteCodes,
  listBindCodesOfStudent,
  redeemInviteCode,
  seedBootstrapUser,
  migrateLegacyOwnership,
  // 用户系统 P2：安全与运营
  recordLoginAttempt,
  countRecentFailedAttempts,
  purgeOldLoginAttempts,
  insertAuditLog,
  listAuditLogs,
  purgeOldAuditLogs,
  getChildStats,
  listExpiredGuests,
  purgeExpiredGuests,
  nextGuestUsername,
};
