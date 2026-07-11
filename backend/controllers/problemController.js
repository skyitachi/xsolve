// 题目管理 controller
import { sessions } from '../session.js';
import {
  getProblemsForClient,
  getProblem,
  getAllProblems,
  deleteProblem,
} from '../db.js';

// GET /api/problems
export function listProblems(req, res) {
  res.json(getProblemsForClient());
}

// DELETE /api/problem/:id
export function removeProblem(req, res) {
  const id = decodeURIComponent(req.params.id);
  if (!id) return res.status(400).json({ error: 'missing id' });
  const p = getProblem(id);
  const removed = deleteProblem(id);
  const remaining = getAllProblems();
  const nextId = remaining.length ? remaining[0].id : null;
  for (const s of sessions.values()) {
    if (s.currentProblemId === id) s.currentProblemId = nextId;
  }
  res.json({
    ok: removed,
    id,
    had: !!p,
    remaining: remaining.length,
    current_problem_id: nextId,
  });
}
