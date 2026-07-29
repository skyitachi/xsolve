import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_PROMPTS } from './prompt-seeds.js';
import { fileURLToPath } from 'url';
import { PROBLEMS as BUILTIN_PROBLEMS } from './problems.js';

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
  `);

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

function insertChatSession({ id, role, title, current_problem_id }) {
  getDb();
  db.prepare(`
    INSERT INTO chat_sessions (id, role, title, current_problem_id)
    VALUES (?, ?, ?, ?)
  `).run(id, role, title || null, current_problem_id || null);
  return getChatSession(id);
}

function getChatSession(id) {
  getDb();
  const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  return row || null;
}

function listChatSessions(role) {
  getDb();
  const rows = role
    ? db.prepare('SELECT * FROM chat_sessions WHERE role = ? AND is_archived = 0 ORDER BY updated_at DESC').all(role)
    : db.prepare('SELECT * FROM chat_sessions WHERE is_archived = 0 ORDER BY updated_at DESC').all();
  return rows;
}

function updateChatSession(id, { title, current_problem_id, is_archived, sdk_session_id }) {
  getDb();
  const sets = [];
  const vals = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
  if (current_problem_id !== undefined) { sets.push('current_problem_id = ?'); vals.push(current_problem_id); }
  if (is_archived !== undefined) { sets.push('is_archived = ?'); vals.push(is_archived ? 1 : 0); }
  if (sdk_session_id !== undefined) { sets.push('sdk_session_id = ?'); vals.push(sdk_session_id); }
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
  insertPromptVersion,
  activatePromptVersion,
  getActivePromptVersion,
  listPromptVersions,
  getPromptVersion,
  listPromptRoles,
  deletePromptVersion,
  seedPromptVersions,
};
