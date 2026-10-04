import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_PROMPTS } from './prompt-seeds.js';
import { fileURLToPath } from 'url';
import { PROBLEMS as BUILTIN_PROBLEMS } from './problems.js';
import { MASTERY_HALFLIFE_DAYS, MASTERY_LEARNING_RATE, BOOTSTRAP_STUDENT_USERNAME, BOOTSTRAP_STUDENT_PASSWORD, AUDIT_RETENTION_DAYS, GUEST_USERNAME_PREFIX, WRONG_BOOK_AUTO_COLLECT, WRONG_BOOK_REVIEW_INTERVALS, WRONG_BOOK_GRADUATE_STREAK } from './config.js';
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
      scratch_strokes INTEGER NOT NULL DEFAULT 0,
      scratch_ocr TEXT,
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
      had_scratch  INTEGER NOT NULL DEFAULT 0,
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

    -- ========== 错题本 ==========
    -- ① 本子：一个学生可以有多个错题本（按科目 / 按专题分）。
    -- 每个学生**必定有一个默认本**（is_default=1），自动收录都进它，
    -- 学生不需要先「创建一个本」才能用。
    CREATE TABLE IF NOT EXISTS wrong_books (
      id          TEXT PRIMARY KEY,
      student_id  TEXT NOT NULL DEFAULT 'me',
      name        TEXT NOT NULL,
      emoji       TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wrong_books_student ON wrong_books(student_id, sort_order, created_at);

    -- ② 错题条目：**一题一行**（同一题错三次仍然只有一个条目，次数记在 wrong_count）。
    --    source 区分三种入口，这是本功能的核心：
    --      auto   = 做题答错时自动收录
    --      manual = 从题库里手动挑进来的
    --      photo  = 拍照 + 视觉解析新录入的题
    CREATE TABLE IF NOT EXISTS wrong_items (
      id              TEXT PRIMARY KEY,
      student_id      TEXT NOT NULL DEFAULT 'me',
      book_id         TEXT NOT NULL,
      problem_id      TEXT NOT NULL,
      source          TEXT NOT NULL DEFAULT 'auto',
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | mastered
      wrong_count     INTEGER NOT NULL DEFAULT 0,
      review_count    INTEGER NOT NULL DEFAULT 0,
      level           INTEGER NOT NULL DEFAULT 0,       -- 记忆等级 0~4，决定下次复习间隔
      review_streak   INTEGER NOT NULL DEFAULT 0,       -- 连续答对次数（复习时错一次归零）
      note            TEXT,                             -- 备注 / 纠错要点（自由文本）
      error_type      TEXT,                             -- 错因枚举：计算|概念|审题|方法|粗心|其他
      error_source    TEXT,                             -- 错因来源：manual 人工 | rule 规则兜底 | ai 对话抽取
      first_wrong_at  INTEGER,
      last_review_at  INTEGER,
      last_correct_at INTEGER,                          -- 含日常作答答对，仅供展示
      next_review_at  INTEGER,                          -- NULL 视为立即到期
      mastered_at     INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- 同一学生同一道题只留一个条目（跨本也不重复）：
    -- 「加入另一个本」= 改 book_id（移动），而不是新增一条，
    -- 否则「今日待复习」会把同一道题数两次。
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wrong_items_student_problem
      ON wrong_items(student_id, problem_id);
    CREATE INDEX IF NOT EXISTS idx_wrong_items_book ON wrong_items(student_id, book_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wrong_items_due  ON wrong_items(student_id, status, next_review_at);

    -- ③ 复习流水：区分「专门重做」与「日常顺带做对」。
    --    这张表是整套复习调度的**信号源**，不能省。
    --    student_attempts 里同样一条 correct=1，可能来自「主动重做」，
    --    也可能来自「AI 刚讲完紧接着做一遍」—— 把两者混在一起统计，
    --    大量错题会被假性判定为已掌握。from_book=0 只作记录，不推进等级。
    CREATE TABLE IF NOT EXISTS wrong_reviews (
      id         TEXT PRIMARY KEY,
      wrong_id   TEXT NOT NULL,
      student_id TEXT NOT NULL,
      problem_id TEXT,
      session_id TEXT,
      attempt_id TEXT,
      correct    INTEGER NOT NULL,
      from_book  INTEGER NOT NULL DEFAULT 1,   -- 0 = 日常流程中被判对，仅记录
      level_after INTEGER,                     -- 本次复习后的等级，便于回溯排期变化
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wrong_reviews_item
      ON wrong_reviews(wrong_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wrong_reviews_student
      ON wrong_reviews(student_id, created_at DESC);
  `);

  // ─── Migration: 错题本 P1（复习调度）───────────────────────────────
  // 老库的 wrong_items 是 P0 建的，上面的 CREATE TABLE IF NOT EXISTS 不会补列，
  // 因此这几个新列必须单独 ALTER。探测手法沿用本文件既有约定：
  // SELECT col LIMIT 0 命中即列已存在，抛错则补列。
  try {
    db.prepare("SELECT review_streak FROM wrong_items LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE wrong_items ADD COLUMN review_streak INTEGER NOT NULL DEFAULT 0");
  }
  try {
    db.prepare("SELECT last_correct_at FROM wrong_items LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE wrong_items ADD COLUMN last_correct_at INTEGER");
  }
  try {
    db.prepare("SELECT error_type FROM wrong_items LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE wrong_items ADD COLUMN error_type TEXT");
  }
  try {
    db.prepare("SELECT error_source FROM wrong_items LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE wrong_items ADD COLUMN error_source TEXT");
  }
  // P0 时"待复习"等同于"pending"（next_review_at 从未被写过）。
  // 升级后要让存量条目立即进入复习队列，而不是永远排在 NULL 里被当成"未排期"。
  db.exec(`
    UPDATE wrong_items
       SET next_review_at = COALESCE(last_review_at, first_wrong_at, created_at)
     WHERE next_review_at IS NULL AND status = 'pending'
  `);

  // Migration: 会话上的「这次做题是主动重做错题」标记。
  // 必须落库而不是只放内存 session 对象 —— session 会被重建/恢复，
  // 内存标记一丢，重做的答对结果就退化成「日常作答」，等级永远不推进。
  try {
    db.prepare("SELECT review_wrong_id FROM chat_sessions LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN review_wrong_id TEXT");
  }

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

  // Migration: 草稿纳入评判——把草稿笔迹与识别结果随 turn 落库。
  // scratch_strokes 记录该轮学生草稿板上的笔画数（0 = 没动笔）；
  // scratch_ocr 记录本轮实际注入给模型的草稿识别文本（未识别则 NULL）。
  // 评估层据此判断「是否动手演算」，不再只能看对话文本。
  try {
    db.prepare("SELECT scratch_strokes FROM chat_turns LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_turns ADD COLUMN scratch_strokes INTEGER NOT NULL DEFAULT 0");
  }
  try {
    db.prepare("SELECT scratch_ocr FROM chat_turns LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE chat_turns ADD COLUMN scratch_ocr TEXT");
  }

  // Migration: 答题流水记录「这次作答有没有动笔」，用于统计动笔率
  try {
    db.prepare("SELECT had_scratch FROM student_attempts LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE student_attempts ADD COLUMN had_scratch INTEGER NOT NULL DEFAULT 0");
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

function insertChatTurn({ id, session_id, role, user_message, ai_message, tool_calls_json, input_tokens, output_tokens, duration_ms, error, prompt_version_id, scratch_strokes, scratch_ocr }) {
  getDb();
  const turnId = id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO chat_turns (id, session_id, role, user_message, ai_message, tool_calls_json, input_tokens, output_tokens, duration_ms, error, prompt_version_id, scratch_strokes, scratch_ocr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    turnId, session_id, role || 'student',
    user_message || null, ai_message || null,
    tool_calls_json || '[]',
    input_tokens || 0, output_tokens || 0, duration_ms || 0,
    error || null,
    prompt_version_id || null,
    scratch_strokes || 0,
    scratch_ocr || null
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
function recordAttempt({ id, student_id, session_id, turn_id, problem_id, topic, user_answer, correct, hint_count, duration_ms, error_type, had_scratch }) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const attemptId = id || crypto.randomUUID();
  const info = db.prepare(`
    INSERT OR IGNORE INTO student_attempts
      (id, student_id, session_id, turn_id, problem_id, topic, user_answer, correct, hint_count, duration_ms, error_type, had_scratch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId, sid, session_id, turn_id ?? null, problem_id ?? null, topic ?? null,
    user_answer ?? null, correct ? 1 : 0, hint_count || 0, duration_ms ?? null, error_type ?? null,
    had_scratch ? 1 : 0
  );
  if (info.changes > 0) {
    if (topic) bumpTopicMastery(sid, topic, !!correct);
    // 错题本结算：只在**真正新写入**一条流水时触发。
    // 这里必须依赖 info.changes > 0（而不是只看 correct 的值）—— 本函数是
    // INSERT OR IGNORE 的去重语义，学生把同一个答案重复提交几次时 changes=0；
    // 无条件结算会把 wrong_count 刷成假数据，还会反复重置复习间隔。
    //
    // P1 起答对也要结算，三条路径统一收在 applyAttemptToWrongBook 里：
    //   答错                    → 自动收录（含错因规则兜底）
    //   答对 + 会话标记了重做   → 推进记忆等级（**回流**）
    //   答对 + 日常作答         → 只记 last_correct_at，不动状态
    if (problem_id != null) {
      try {
        applyAttemptToWrongBook(sid, {
          session_id, problem_id, user_answer, correct: !!correct,
        });
      } catch (e) {
        // 错题本结算失败绝不能影响答题主流程
        console.error('[db] wrong book hook failed:', e.message);
      }
    }
  } else if (turn_id && problem_id != null && user_answer != null) {
    // 命中去重（通常是 record_history 工具先写入、turn_id 为空）：
    // 由随后的 persistTurn 自动落库回填 turn_id，便于把答题流水追溯回具体 turn；
    // had_scratch 取两次写入的较大值（任一路径知道学生动过笔就算动过）。
    db.prepare(`
      UPDATE student_attempts SET turn_id = ?, had_scratch = MAX(had_scratch, ?)
      WHERE session_id = ? AND problem_id = ? AND user_answer = ? AND turn_id IS NULL
    `).run(turn_id, had_scratch ? 1 : 0, session_id, problem_id, user_answer);
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

// ========== 错题本 ==========

const DEFAULT_BOOK_NAME = '我的错题本';
const DEFAULT_BOOK_EMOJI = '📕';

/**
 * 保证该学生有一个默认错题本，返回它。
 * 「自动收录」和「拍照录入」都落在默认本上，学生不需要先手动建本才能用。
 */
function ensureDefaultBook(sid) {
  getDb();
  const existing = db
    .prepare('SELECT * FROM wrong_books WHERE student_id = ? AND is_default = 1 ORDER BY created_at LIMIT 1')
    .get(sid);
  if (existing) return existing;
  const id = 'wb_' + crypto.randomUUID();
  db.prepare(`
    INSERT INTO wrong_books (id, student_id, name, emoji, is_default, sort_order)
    VALUES (?, ?, ?, ?, 1, 0)
  `).run(id, sid, DEFAULT_BOOK_NAME, DEFAULT_BOOK_EMOJI);
  return db.prepare('SELECT * FROM wrong_books WHERE id = ?').get(id);
}

function listWrongBooks(student_id) {
  const sid = student_id || DEFAULT_STUDENT_ID;
  ensureDefaultBook(sid);
  const books = db.prepare(`
    SELECT * FROM wrong_books WHERE student_id = ?
    ORDER BY is_default DESC, sort_order, created_at
  `).all(sid);
  const counts = db.prepare(`
    SELECT book_id,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
    FROM wrong_items WHERE student_id = ? GROUP BY book_id
  `).all(sid);
  const byId = new Map(counts.map((c) => [c.book_id, c]));
  return books.map((b) => ({
    id: b.id,
    name: b.name,
    emoji: b.emoji,
    is_default: !!b.is_default,
    created_at: b.created_at,
    total: byId.get(b.id)?.total || 0,
    pending: byId.get(b.id)?.pending || 0,
  }));
}

function getWrongBook(id, student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare('SELECT * FROM wrong_books WHERE id = ? AND student_id = ?').get(id, sid) || null;
}

function createWrongBook(student_id, { name, emoji } = {}) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    const err = new Error('错题本名称不能为空');
    err.status = 400;
    throw err;
  }
  if (trimmed.length > 30) {
    const err = new Error('错题本名称最多 30 个字');
    err.status = 400;
    throw err;
  }
  const dup = db
    .prepare('SELECT id FROM wrong_books WHERE student_id = ? AND name = ?')
    .get(sid, trimmed);
  if (dup) {
    const err = new Error('已经有同名的错题本了');
    err.status = 409;
    throw err;
  }
  const id = 'wb_' + crypto.randomUUID();
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM wrong_books WHERE student_id = ?')
    .get(sid).m;
  db.prepare(`
    INSERT INTO wrong_books (id, student_id, name, emoji, is_default, sort_order)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(id, sid, trimmed, emoji || '📗', maxOrder + 1);
  return getWrongBook(id, sid);
}

function renameWrongBook(id, student_id, name) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const book = getWrongBook(id, sid);
  if (!book) return null;
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    const err = new Error('错题本名称不能为空');
    err.status = 400;
    throw err;
  }
  db.prepare('UPDATE wrong_books SET name = ? WHERE id = ? AND student_id = ?').run(trimmed.slice(0, 30), id, sid);
  return getWrongBook(id, sid);
}

/**
 * 删除错题本。默认本不允许删除（自动收录要有落点）。
 * 本子里的条目**不删除**，而是移动回默认本 —— 学生删的是分类，不是题目，
 * 直接连题目一起删掉太容易误伤。
 */
function deleteWrongBook(id, student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const book = getWrongBook(id, sid);
  if (!book) return { ok: false, reason: 'not_found' };
  if (book.is_default) return { ok: false, reason: 'is_default' };
  const fallback = ensureDefaultBook(sid);
  const moved = db
    .prepare('UPDATE wrong_items SET book_id = ? WHERE student_id = ? AND book_id = ?')
    .run(fallback.id, sid, id).changes;
  db.prepare('DELETE FROM wrong_books WHERE id = ? AND student_id = ?').run(id, sid);
  return { ok: true, moved, moved_to: fallback.id };
}

function rowToWrongItem(r) {
  return {
    id: r.id,
    book_id: r.book_id,
    problem_id: r.problem_id,
    source: r.source,
    status: r.status,
    wrong_count: r.wrong_count,
    review_count: r.review_count,
    level: r.level,
    review_streak: r.review_streak || 0,
    note: r.note || null,
    error_type: r.error_type || null,
    error_source: r.error_source || null,
    created_at: r.created_at,
    first_wrong_at: r.first_wrong_at || null,
    last_review_at: r.last_review_at || null,
    last_correct_at: r.last_correct_at || null,
    next_review_at: r.next_review_at || null,
    mastered_at: r.mastered_at || null,
    topic: r.p_topic || null,
    text: r.p_text || null,
    has_image: !!r.has_image,
    has_figure: !!r.has_figure,
    problem_exists: r.p_text != null,
  };
}

// ─── 复习调度（P1）────────────────────────────────────────────────
// 等级 → 下次复习间隔（天）。二元信号下这是比 SM-2 更诚实的模型：
// 本项目只有「对 / 错」，没有"勉强想起来"这种中间态，SM-2 的难度因子无从估计。
const REVIEW_INTERVAL_DAYS = (WRONG_BOOK_REVIEW_INTERVALS && WRONG_BOOK_REVIEW_INTERVALS.length)
  ? WRONG_BOOK_REVIEW_INTERVALS
  : [1, 3, 7, 15, 30];                            // 下标 = 等级 0~N
const REVIEW_MAX_LEVEL = REVIEW_INTERVAL_DAYS.length - 1;
const REVIEW_GRADUATE_STREAK = WRONG_BOOK_GRADUATE_STREAK || 2;
const DAY_SECONDS = 86400;

/** 某等级对应的下次复习时间戳。等级越界时按封顶间隔走。 */
function nextReviewAtForLevel(level, fromTs = Math.floor(Date.now() / 1000)) {
  const lv = Math.max(0, Math.min(Number(level) || 0, REVIEW_MAX_LEVEL));
  return fromTs + REVIEW_INTERVAL_DAYS[lv] * DAY_SECONDS;
}

function listWrongItems(student_id, {
  bookId = null, status = null, errorType = null, sort = null, limit = 200, offset = 0,
} = {}) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const now = Math.floor(Date.now() / 1000);
  const where = ['w.student_id = ?'];
  const args = [sid];
  if (bookId) { where.push('w.book_id = ?'); args.push(bookId); }
  // status=due 是「今日待复习」：未掌握 + 已到期（next_review_at 为 NULL 视为立即到期）
  if (status === 'due') {
    where.push("w.status <> 'mastered'");
    where.push('(w.next_review_at IS NULL OR w.next_review_at <= ?)');
    args.push(now);
  } else if (status) {
    where.push('w.status = ?');
    args.push(status);
  }
  if (errorType === 'none') {
    where.push("(w.error_type IS NULL OR w.error_type = '')");
  } else if (errorType) {
    where.push('w.error_type = ?');
    args.push(errorType);
  }

  // 排序：due 一律按「何时到期」升序，逾期越久越靠前。
  // next_review_at 为 NULL（手动加入 / 拍照录入还没排过期）用 first_wrong_at、
  // 再退到 created_at 兜底 —— 不用「NULL 排最前」那种特例，
  // 否则一堆积压的题会永远压在真正逾期最久的题前面。
  let orderBy;
  if (status === 'due') {
    orderBy = 'COALESCE(w.next_review_at, w.first_wrong_at, w.created_at) ASC';
  } else if (sort === 'wrong') {
    orderBy = '(w.status = \'mastered\'), w.wrong_count DESC, w.created_at DESC';
  } else if (sort === 'stale') {
    orderBy = "(w.status = 'mastered'), COALESCE(w.next_review_at, w.last_review_at, w.created_at) ASC";
  } else {
    orderBy = "(w.status = 'mastered'), w.created_at DESC";
  }

  const rows = db.prepare(`
    SELECT w.*, p.topic AS p_topic, p.text AS p_text,
           (p.image_dataurl IS NOT NULL) AS has_image,
           (p.figure_json IS NOT NULL) AS has_figure
    FROM wrong_items w
    LEFT JOIN problems p ON p.id = w.problem_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...args, Math.min(Number(limit) || 200, 500), Number(offset) || 0);
  return rows.map(rowToWrongItem);
}

function getWrongItem(id, student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const r = db.prepare(`
    SELECT w.*, p.topic AS p_topic, p.text AS p_text,
           (p.image_dataurl IS NOT NULL) AS has_image,
           (p.figure_json IS NOT NULL) AS has_figure
    FROM wrong_items w
    LEFT JOIN problems p ON p.id = w.problem_id
    WHERE w.id = ? AND w.student_id = ?
  `).get(id, sid);
  return r ? rowToWrongItem(r) : null;
}

function findWrongItemByProblem(student_id, problemId) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const r = db
    .prepare('SELECT * FROM wrong_items WHERE student_id = ? AND problem_id = ?')
    .get(sid, problemId);
  return r || null;
}

/**
 * 加入错题本（三种入口共用）。
 * 已有的条目**不新增一行**，而是「移动 + 重新激活」—— 因为
 * uq_wrong_items_student_problem 约束一题一条，也避免待复习数被重复计。
 *
 * @returns {{item:object, created:boolean}}
 */
function addWrongItem(student_id, { bookId, problemId, source = 'manual', note = null, countWrong = false, wrongCount = null } = {}) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  if (!problemId) {
    const err = new Error('缺少题目 id');
    err.status = 400;
    throw err;
  }
  // delta：这次加入要给 wrong_count 加多少。
  //   countWrong=true  → +1（真实的「又错一次」）
  //   wrongCount=n     → 直接给 n（回填历史用：一次加入对应历史上 n 次出错，而不是 1）
  const delta = wrongCount != null ? Math.max(0, Number(wrongCount) || 0) : (countWrong ? 1 : 0);
  const book = bookId ? getWrongBook(bookId, sid) : ensureDefaultBook(sid);
  if (!book) {
    const err = new Error('错题本不存在');
    err.status = 404;
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  // 「真的又错了一次」（delta > 0）要把记忆状态打回原形：
  // 等级归零、连续答对归零、立刻回到待复习队列。
  // 手动加入 / 拍照录入（delta = 0）**不能**碰这些字段 —— 主动收藏不等于又错了一次。
  const isWrongEvent = delta > 0 ? 1 : 0;
  const existing = findWrongItemByProblem(sid, problemId);
  if (existing) {
    db.prepare(`
      UPDATE wrong_items
         SET book_id        = ?,
             status         = 'pending',
             mastered_at    = NULL,
             note           = COALESCE(?, note),
             wrong_count    = wrong_count + ?,
             first_wrong_at = COALESCE(first_wrong_at, ?),
             level          = CASE WHEN ? = 1 THEN 0 ELSE level END,
             review_streak  = CASE WHEN ? = 1 THEN 0 ELSE review_streak END,
             next_review_at = CASE WHEN ? = 1 THEN ? ELSE next_review_at END
       WHERE id = ?
    `).run(
      book.id, note, delta, isWrongEvent ? now : null,
      isWrongEvent, isWrongEvent, isWrongEvent, now,
      existing.id
    );
    return { item: getWrongItem(existing.id, sid), created: false };
  }
  const id = 'wi_' + crypto.randomUUID();
  db.prepare(`
    INSERT INTO wrong_items
      (id, student_id, book_id, problem_id, source, status, wrong_count, note,
       first_wrong_at, next_review_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id, sid, book.id, problemId, source, delta, note,
    isWrongEvent ? now : null,
    isWrongEvent ? now : null
  );
  return { item: getWrongItem(id, sid), created: true };
}

function removeWrongItem(id, student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const info = db.prepare('DELETE FROM wrong_items WHERE id = ? AND student_id = ?').run(id, sid);
  return info.changes > 0;
}

/** 标记 / 取消「已掌握」。取消时回到待复习。 */
function setWrongItemMastered(id, student_id, mastered) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    UPDATE wrong_items
       SET status = ?, mastered_at = ?, next_review_at = NULL
     WHERE id = ? AND student_id = ?
  `).run(mastered ? 'mastered' : 'pending', mastered ? now : null, id, sid);
  return info.changes > 0 ? getWrongItem(id, sid) : null;
}

/**
 * 记一次「重做」动作（还没结算结果）。真正的掌握判定在 recordWrongReview。
 * 两个函数分工：本函数 = 学生点了「重做」这个动作；那个 = 重做的**结果**。
 */
function touchWrongItemReview(id, student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare(`
    UPDATE wrong_items
       SET review_count = review_count + 1, last_review_at = ?
     WHERE id = ? AND student_id = ?
  `).run(now, id, sid);
  return info.changes > 0 ? getWrongItem(id, sid) : null;
}

// ─── 错因（P1）────────────────────────────────────────────────────
// 枚举固定，不用自由文本 —— 否则无法统计聚合。自由描述留给 note。
const ERROR_TYPES = ['计算', '概念', '审题', '方法', '粗心', '其他'];

/**
 * 规则兜底的错因猜测。**只在没有人工标注时使用**，且记为 error_source='rule'（低置信）。
 * 逻辑刻意保守：拿不准就返回 null 留空。宁可显示「未归因」，
 * 也不要为了填满字段而编造分类 —— 错因数据一旦不可信，整张分布图就是噪声。
 */
function guessErrorType(userAnswer, correctAnswer) {
  const u = String(userAnswer ?? '').trim();
  const a = String(correctAnswer ?? '').trim();
  if (!u || !a) return null;
  const bare = (s) => s.replace(/\s/g, '');
  const isNum = (s) => /^-?\d+(\.\d+)?$/.test(bare(s));
  const uIsNum = isNum(u);
  const aIsNum = isNum(a);
  // 两边都是纯数字：量级相近 → 更可能是算错；差得离谱 → 更像是概念没抓对
  if (uIsNum && aIsNum) {
    const nu = parseFloat(bare(u));
    const na = parseFloat(bare(a));
    if (Number.isFinite(nu) && Number.isFinite(na) && na !== 0) {
      return Math.abs(nu - na) / Math.abs(na) <= 2 ? '计算' : '概念';
    }
    return '计算';
  }
  // 形态完全不同（一个是数值、一个是表达式或文字）→ 概念或审题层面出了问题
  if (uIsNum !== aIsNum) return '概念';
  return null;
}

/** 写一条复习流水。from_book=0 只作记录，不参与等级推进。 */
function insertWrongReview({ wrongId, studentId, problemId = null, sessionId = null, attemptId = null, correct, fromBook = true, levelAfter = null }) {
  db.prepare(`
    INSERT INTO wrong_reviews
      (id, wrong_id, student_id, problem_id, session_id, attempt_id, correct, from_book, level_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'wr_' + crypto.randomUUID(), wrongId, studentId, problemId, sessionId, attemptId,
    correct ? 1 : 0, fromBook ? 1 : 0, levelAfter
  );
}

/**
 * 记一次复习结果，并推进记忆状态机 —— 整套复习调度的核心。
 *
 * 状态机（对应设计文档 §3 的流程图与 §6 的间隔表）：
 *   答对（来自错题本）→ level+1（封顶）、review_streak+1、按新等级排下次复习；
 *                        若 review_streak ≥ N 且 level 已封顶 → 毕业（mastered）
 *   答错（来自错题本）→ level 归零、review_streak 归零、wrong_count+1、次日再练
 *   答对（日常作答）  → **只记 last_correct_at**，状态/等级/连续答对一律不动
 *
 * 最后一条是整张表的意义所在：日常作答里「AI 刚讲完紧接着做对」不是掌握的证据，
 * 若让它推进等级，大量错题会被假性判定为已掌握。
 *
 * @returns {{item:object, graduated:boolean, correct:boolean, advanced:boolean}|null}
 */
function recordWrongReview(student_id, {
  wrongId = null, problemId = null, correct, sessionId = null, attemptId = null, fromBook = true,
} = {}) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const item = wrongId ? getWrongItem(wrongId, sid)
    : (problemId ? findWrongItemByProblem(sid, problemId) : null);
  if (!item) return null;

  const now = Math.floor(Date.now() / 1000);
  const isCorrect = !!correct;

  if (!fromBook) {
    if (isCorrect) {
      db.prepare('UPDATE wrong_items SET last_correct_at = ? WHERE id = ? AND student_id = ?')
        .run(now, item.id, sid);
    }
    insertWrongReview({
      wrongId: item.id, studentId: sid, problemId: item.problem_id,
      sessionId, attemptId, correct: isCorrect, fromBook: false, levelAfter: item.level,
    });
    return { item: getWrongItem(item.id, sid), graduated: false, correct: isCorrect, advanced: false };
  }

  let level = item.level || 0;
  let streak = item.review_streak || 0;
  let status = 'pending';
  let masteredAt = null;
  let nextAt;

  if (isCorrect) {
    level = Math.min(level + 1, REVIEW_MAX_LEVEL);
    streak += 1;
    // 毕业 = 连续答对达标 **且** 等级已封顶。只有连续答对防不住「一口气做对四次」，
    // 加上等级封顶意味着这四次是**跨了 3/7/15 天的间隔**做对的，才叫真的记住。
    if (streak >= REVIEW_GRADUATE_STREAK && level >= REVIEW_MAX_LEVEL) {
      status = 'mastered';
      masteredAt = now;
      nextAt = null;
    } else {
      nextAt = nextReviewAtForLevel(level, now);
    }
  } else {
    level = 0;
    streak = 0;
    nextAt = nextReviewAtForLevel(0, now);
  }

  db.prepare(`
    UPDATE wrong_items
       SET level          = ?,
           review_streak  = ?,
           status         = ?,
           mastered_at    = ?,
           next_review_at = ?,
           last_review_at = ?,
           last_correct_at = ?,
           review_count   = review_count + 1,
           wrong_count    = wrong_count + ?
     WHERE id = ? AND student_id = ?
  `).run(
    level, streak, status, masteredAt, nextAt, now,
    isCorrect ? now : item.last_correct_at,
    isCorrect ? 0 : 1,
    item.id, sid
  );

  insertWrongReview({
    wrongId: item.id, studentId: sid, problemId: item.problem_id,
    sessionId, attemptId, correct: isCorrect, fromBook: true, levelAfter: level,
  });

  return {
    item: getWrongItem(item.id, sid),
    graduated: status === 'mastered',
    correct: isCorrect,
    advanced: true,
  };
}

/** 错因 / 备注的人工标注。errorType 传 null 表示清空归因。 */
function setWrongItemMeta(id, student_id, { errorType, note } = {}) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const sets = [];
  const args = [];
  if (errorType !== undefined) {
    const et = (errorType === null || errorType === '') ? null : String(errorType).trim();
    if (et && !ERROR_TYPES.includes(et)) {
      const err = new Error('错因不在枚举范围内：' + et);
      err.status = 400;
      throw err;
    }
    sets.push('error_type = ?', 'error_source = ?');
    args.push(et, et ? 'manual' : null);
  }
  if (note !== undefined) {
    sets.push('note = ?');
    args.push(note === null ? null : String(note).slice(0, 500));
  }
  if (!sets.length) return getWrongItem(id, sid);
  const info = db.prepare(`UPDATE wrong_items SET ${sets.join(', ')} WHERE id = ? AND student_id = ?`)
    .run(...args, id, sid);
  return info.changes > 0 ? getWrongItem(id, sid) : null;
}

// ─── 会话上的「本次做题 = 重做某道错题」标记 ──────────────────────
// 必须落库：session 对象会被重建/恢复，内存标记一丢，重做的答对结果就退化成
// 「日常作答」，等级永远不推进 —— 且这种失效是静默的。

function setSessionReviewWrongId(sessionId, wrongId) {
  if (!sessionId) return;
  getDb();
  db.prepare('UPDATE chat_sessions SET review_wrong_id = ? WHERE id = ?').run(wrongId || null, sessionId);
}

function getSessionReviewWrongId(sessionId) {
  if (!sessionId) return null;
  getDb();
  const r = db.prepare('SELECT review_wrong_id FROM chat_sessions WHERE id = ?').get(sessionId);
  return r ? (r.review_wrong_id || null) : null;
}

/**
 * 把一次答题流水反映到错题本。由 recordAttempt 在**真正写入**之后调用。
 *
 * 三条路径：
 *   答错                        → 自动收录（不存在且开关打开时才新建）
 *   答对 + 会话标记了重做       → 推进复习等级（**回流**），结算后清除标记
 *   答对 + 日常作答             → 只记 last_correct_at，不动状态
 *
 * 「一次重做只结算一次」：结算后立刻清掉会话标记，同一会话里后续作答按日常作答处理。
 * 这样「连续答对 2 次」必然跨两次从错题本进入的重做 —— 正是间隔模型要的语义。
 */
function applyAttemptToWrongBook(sid, { session_id = null, problem_id = null, user_answer = null, correct = false } = {}) {
  if (problem_id == null) return;
  const item = findWrongItemByProblem(sid, problem_id);
  const reviewWrongId = getSessionReviewWrongId(session_id);
  // 会话标记的错题必须与本次作答的题目一致 —— 挡住「切题后判上一题」
  // 把结果记到另一个条目上的情况（项目里踩过同类坑）。
  const isReview = !!reviewWrongId && !!item && reviewWrongId === item.id;

  if (correct) {
    if (!item) return;                       // 答对且不在错题本 → 无需处理
    recordWrongReview(sid, {
      wrongId: item.id, correct: true, sessionId: session_id, fromBook: isReview,
    });
    if (isReview) setSessionReviewWrongId(session_id, null);
    return;
  }

  if (isReview) {
    recordWrongReview(sid, { wrongId: item.id, correct: false, sessionId: session_id, fromBook: true });
    setSessionReviewWrongId(session_id, null);
    return;
  }
  // 已收录的题：无论自动收录开关如何，都要如实反映「这道题又错了」；
  // 开关只决定**要不要新收一道题**，不该让已收录题的状态停在假象上。
  if (item || WRONG_BOOK_AUTO_COLLECT) {
    autoCollectWrongItem(sid, problem_id, { userAnswer: user_answer });
  }
}

/** 某条错题的复习流水（最近优先）—— 让「回流是否真的发生」可见，而不只是信任一个等级数字。 */
function listWrongReviews(wrongId, student_id, limit = 10) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  return db.prepare(`
    SELECT id, correct, from_book, level_after, session_id, created_at
      FROM wrong_reviews
     WHERE wrong_id = ? AND student_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?
  `).all(wrongId, sid, Math.min(Math.max(Number(limit) || 10, 1), 50))
    .map((r) => ({
      correct: !!r.correct,
      // 只有「主动重做」才推进等级；日常作答对状态无影响，但仍如实记录
      from_book: !!r.from_book,
      level_after: r.level_after,
      at: r.created_at,
    }));
}

/** 今日待复习（轻量：只给计数与主题分布，供对话注入摘要用）。 */
function getWrongBookDueSummary(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const now = Math.floor(Date.now() / 1000);
  const due = db.prepare(`
    SELECT COUNT(*) AS n FROM wrong_items
     WHERE student_id = ? AND status <> 'mastered'
       AND (next_review_at IS NULL OR next_review_at <= ?)
  `).get(sid, now);
  const topics = db.prepare(`
    SELECT COALESCE(p.topic, '未分类') AS topic, COUNT(*) AS n
      FROM wrong_items w LEFT JOIN problems p ON p.id = w.problem_id
     WHERE w.student_id = ? AND w.status <> 'mastered'
       AND (w.next_review_at IS NULL OR w.next_review_at <= ?)
     GROUP BY COALESCE(p.topic, '未分类')
     ORDER BY n DESC LIMIT 8
  `).all(sid, now);
  return { due: due.n || 0, topics };
}

/** 某道题上最后一次「写错的答案」—— 复习时「我当初错成了什么」比正确答案更有用。 */
function getLatestWrongAnswer(student_id, problem_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  const row = db.prepare(`
    SELECT user_answer, created_at
    FROM student_attempts
    WHERE student_id = ? AND problem_id = ? AND correct = 0
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(sid, problem_id);
  return row ? { answer: row.user_answer, at: row.created_at } : null;
}

/** 错题本总览：待复习 / 已掌握 / 最久未练天数 / 近 7 天清掉几道 / 来源与错因分布。 */
function getWrongBookStats(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;
  ensureDefaultBook(sid);
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status <> 'mastered' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status =  'mastered' THEN 1 ELSE 0 END) AS mastered,
           SUM(CASE WHEN status <> 'mastered'
                     AND (next_review_at IS NULL OR next_review_at <= ?)
                    THEN 1 ELSE 0 END) AS due,
           MIN(CASE WHEN status <> 'mastered'
                    THEN COALESCE(next_review_at, created_at) END) AS oldest
    FROM wrong_items WHERE student_id = ?
  `).get(now, sid);
  const sources = db.prepare(`
    SELECT source, COUNT(*) AS n FROM wrong_items WHERE student_id = ? GROUP BY source
  `).all(sid);
  // 错因分布：未归因单独成一类 —— 「留空 ≠ 失败」，要在 UI 上能看到还差多少没标。
  const errors = db.prepare(`
    SELECT COALESCE(NULLIF(error_type, ''), '未归因') AS kind, COUNT(*) AS n
      FROM wrong_items WHERE student_id = ?
     GROUP BY COALESCE(NULLIF(error_type, ''), '未归因')
     ORDER BY n DESC
  `).all(sid);
  const books = db.prepare('SELECT COUNT(*) AS n FROM wrong_books WHERE student_id = ?').get(sid);
  const cleared = db.prepare(`
    SELECT COUNT(*) AS n FROM wrong_items
     WHERE student_id = ? AND status = 'mastered' AND mastered_at >= ?
  `).get(sid, now - 7 * DAY_SECONDS);
  // 下次到期时间：空态要靠它说出「下次什么时候该练」，否则孩子只会看到一句"没有错题"
  const nextDue = db.prepare(`
    SELECT MIN(next_review_at) AS t FROM wrong_items
     WHERE student_id = ? AND status <> 'mastered' AND next_review_at > ?
  `).get(sid, now);

  return {
    books: books.n || 0,
    total: row.total || 0,
    pending: row.pending || 0,
    mastered: row.mastered || 0,
    due: row.due || 0,
    // 最久未练的天数：逾期最久的那道题已经放了多久
    overdue_days: row.oldest ? Math.max(0, Math.floor((now - row.oldest) / DAY_SECONDS)) : 0,
    next_due_at: nextDue.t || null,
    last7_mastered: cleared.n || 0,
    by_source: Object.fromEntries(sources.map((s) => [s.source, s.n])),
    by_error: Object.fromEntries(errors.map((e) => [e.kind, e.n])),
  };
}

/**
 * 自动收录：答题流水判定为「错」时调用。
 * 只做 upsert，绝不抛异常影响答题主流程（收录失败不该让学生答不了题）。
 */
function autoCollectWrongItem(sid, problemId, { userAnswer = null } = {}) {
  try {
    const book = ensureDefaultBook(sid);
    const { item } = addWrongItem(sid, { bookId: book.id, problemId, source: 'auto', countWrong: true });
    // 错因规则兜底（P1 第②层）：只在**还没有归因**时写入，且记 error_source='rule' 标为低置信。
    // 人工标注过的绝不覆盖 —— 人知道为什么错，规则只是猜。
    try {
      if (item && !item.error_type && userAnswer != null) {
        const p = getProblem(problemId);
        const guess = guessErrorType(userAnswer, p ? p.answer : null);
        if (guess) {
          db.prepare(`
            UPDATE wrong_items SET error_type = ?, error_source = 'rule'
             WHERE id = ? AND student_id = ?
               AND (error_source IS NULL OR error_source <> 'manual')
          `).run(guess, item.id, sid);
        }
      }
    } catch { /* 兜底失败不影响收录 */ }
    return true;
  } catch (e) {
    console.error('[db] auto collect wrong item failed:', e.message);
    return false;
  }
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

/**
 * 草稿（动手演算）使用情况统计。
 * 数据来自两个落点：chat_turns（每轮是否动笔 / 是否成功识别）与
 * student_attempts.had_scratch（作答时是否动笔）。
 *
 * 返回「动笔轮次占比」以及「动笔作答 vs 不动笔作答」的正确率对比 ——
 * 后者是草稿是否帮上忙的直接证据，也供评估层与学习档案页使用。
 */
function getScratchUsageStats(student_id) {
  getDb();
  const sid = student_id || DEFAULT_STUDENT_ID;

  const turns = db.prepare(`
    SELECT
      COUNT(*)                                              AS turns_total,
      SUM(CASE WHEN scratch_strokes > 0 THEN 1 ELSE 0 END)  AS turns_with_scratch,
      SUM(CASE WHEN scratch_ocr IS NOT NULL AND scratch_ocr <> '' THEN 1 ELSE 0 END) AS turns_recognized
    FROM chat_turns t
    JOIN chat_sessions s ON s.id = t.session_id
    WHERE s.student_id = ?
  `).get(sid) || {};

  const attempts = db.prepare(`
    SELECT
      COUNT(*)                                            AS attempts_total,
      SUM(CASE WHEN had_scratch = 1 THEN 1 ELSE 0 END)    AS attempts_with_scratch,
      SUM(CASE WHEN had_scratch = 1 AND correct = 1 THEN 1 ELSE 0 END) AS correct_with_scratch,
      SUM(CASE WHEN had_scratch = 0 THEN 1 ELSE 0 END)    AS attempts_without_scratch,
      SUM(CASE WHEN had_scratch = 0 AND correct = 1 THEN 1 ELSE 0 END) AS correct_without_scratch
    FROM student_attempts
    WHERE student_id = ?
  `).get(sid) || {};

  const turnsTotal = turns.turns_total || 0;
  const turnsWith = turns.turns_with_scratch || 0;
  const attemptsWith = attempts.attempts_with_scratch || 0;
  const attemptsWithout = attempts.attempts_without_scratch || 0;

  return {
    turns_total: turnsTotal,
    turns_with_scratch: turnsWith,
    turns_recognized: turns.turns_recognized || 0,
    scratch_turn_ratio: turnsTotal > 0 ? turnsWith / turnsTotal : 0,
    attempts_total: attempts.attempts_total || 0,
    attempts_with_scratch: attemptsWith,
    attempts_without_scratch: attemptsWithout,
    accuracy_with_scratch: attemptsWith > 0 ? (attempts.correct_with_scratch || 0) / attemptsWith : null,
    accuracy_without_scratch: attemptsWithout > 0 ? (attempts.correct_without_scratch || 0) / attemptsWithout : null,
  };
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
  // Wrong Book（错题本）
  ensureDefaultBook,
  listWrongBooks,
  getWrongBook,
  createWrongBook,
  renameWrongBook,
  deleteWrongBook,
  listWrongItems,
  getWrongItem,
  findWrongItemByProblem,
  addWrongItem,
  removeWrongItem,
  setWrongItemMastered,
  touchWrongItemReview,
  recordWrongReview,
  setWrongItemMeta,
  setSessionReviewWrongId,
  getSessionReviewWrongId,
  getWrongBookDueSummary,
  listWrongReviews,
  ERROR_TYPES,
  getWrongBookStats,
  getLatestWrongAnswer,
  getTopicMastery,
  getRecentAttempts,
  getAttemptsByTopic,
  getStudentProfile,
  upsertStudentProfile,
  insertMemoryFact,
  getMemoryFacts,
  getDailyAccuracy,
  getErrorTypeDistribution,
  getScratchUsageStats,
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
