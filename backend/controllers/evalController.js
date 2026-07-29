// 评估 controller
import {
  getEvalScoresByTurn,
  getEvalScoresBySession,
  getSessionEvalScores,
  getSessionEvalSummary,
  getSessionEvalList,
  getStudentEvalSummary,
  getStudentEvalList,
  getEvalDashboard,
  getEvalTurns,
  getChatTurns,
  getChatSession,
} from '../db.js';
import { judgeTurn } from '../eval/llm-judge.js';
import { judgeSession } from '../eval/session-judge.js';
import { evalStudent } from '../eval/student-eval.js';

// GET /api/eval/dashboard?role=student
export function evalDashboard(req, res) {
  const role = req.query.role;
  const data = getEvalDashboard(role);
  res.json(data);
}

// GET /api/eval/turns?page=1&pageSize=20&role=student
export function evalTurns(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize) || 20));
  const role = req.query.role;
  const data = getEvalTurns(page, pageSize, role);
  res.json(data);
}

// GET /api/eval/scores/:turnId
export function getTurnScores(req, res) {
  const turnId = req.params.turnId;
  const scores = getEvalScoresByTurn(turnId);
  res.json(scores);
}

// GET /api/eval/scores/session/:sessionId
export function getSessionScores(req, res) {
  const sessionId = req.params.sessionId;
  const scores = getEvalScoresBySession(sessionId);
  res.json(scores);
}

// POST /api/eval/judge/:turnId — 手动触发 turn 级 LLM Judge
export async function triggerJudge(req, res) {
  const turnId = req.params.turnId;
  const turns = getChatTurns(req.body?.session_id || '');
  const turn = turns.find(t => t.id === turnId);
  if (!turn) return res.status(404).json({ error: 'turn not found' });

  try {
    const result = await judgeTurn(turn, req.body?.session_id || turn.session_id, req.body?.current_problem_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/eval/session/:sessionId/scores — 获取 session 级评估分数
export function getSessionEvalScoresHandler(req, res) {
  const sessionId = req.params.sessionId;
  const scores = getSessionEvalScores(sessionId);
  res.json(scores);
}

// POST /api/eval/session/:sessionId/judge — 手动触发 session 级 LLM Judge
export async function triggerSessionJudge(req, res) {
  const sessionId = req.params.sessionId;
  const session = getChatSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });

  try {
    const result = await judgeSession(sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/eval/session-summary?role=student — 获取 session 级评估汇总
export function sessionEvalSummary(req, res) {
  const role = req.query.role;
  const data = getSessionEvalSummary(role);
  res.json(data);
}

// GET /api/eval/sessions?role=student — 获取 session 列表及评估分数
export function sessionEvalList(req, res) {
  const role = req.query.role;
  const data = getSessionEvalList(role);
  res.json(data);
}

// ========== Student Eval ==========

// GET /api/eval/student/summary?role=student — 学生评估汇总
export function studentEvalSummary(req, res) {
  const role = req.query.role;
  const data = getStudentEvalSummary(role);
  res.json(data);
}

// GET /api/eval/student/sessions?role=student — 学生评估 session 列表
export function studentEvalList(req, res) {
  const role = req.query.role;
  const data = getStudentEvalList(role);
  res.json(data);
}

// POST /api/eval/student/judge/:sessionId — 手动触发学生评估
export async function triggerStudentEval(req, res) {
  const sessionId = req.params.sessionId;
  const session = getChatSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });

  try {
    const result = await evalStudent(sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
