// 健康检查 controller
import { sessions } from '../session.js';
import { getAllProblems } from '../db.js';

export function healthCheck(req, res) {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    sessions: sessions.size,
    problems: getAllProblems().length,
    version: '0.1.0',
  });
}
