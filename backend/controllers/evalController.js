// 评估 controller
import {
  getEvalScoresByTurn,
  getEvalScoresBySession,
  getEvalDashboard,
  getChatTurns,
} from '../db.js';
import { judgeTurn } from '../eval/llm-judge.js';

// GET /api/eval/dashboard?role=student
export function evalDashboard(req, res) {
  const role = req.query.role;
  const data = getEvalDashboard(role);
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

// POST /api/eval/judge/:turnId — 手动触发 LLM Judge
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
