// 学生记忆读取 controller —— 学习档案页（student-memory.html）的数据源。
// 只读聚合 + 一个手动触发固化的入口。
import {
  getStudentProfile, getTopicMastery, getRecentAttempts, getMemoryFacts,
  getAttemptStats, getDailyAccuracy, getErrorTypeDistribution,
} from '../db.js';
import { consolidateStudent } from '../memory/consolidate.js';

const DEFAULT_STUDENT_ID = 'me';

// GET /api/memory/overview?days=30&student_id=me
export function memoryOverview(req, res) {
  try {
    const sid = req.query.student_id || DEFAULT_STUDENT_ID;
    const days = Math.max(1, Math.min(180, parseInt(req.query.days) || 30));

    const stats = getAttemptStats(sid);
    const mastery = getTopicMastery(sid).map((m) => ({
      topic: m.topic,
      mastery: Math.round((m.mastery || 0) * 100), // 转为百分比
      attempts: m.attempts,
      correct: m.correct,
      last_seen: m.last_seen,
    }));
    const attempts = getRecentAttempts(sid, 50);
    const profile = getStudentProfile(sid);
    const facts = getMemoryFacts(sid, 30);
    const daily = getDailyAccuracy(sid, days);
    const errorDist = getErrorTypeDistribution(sid);

    res.json({
      student_id: sid,
      generated_at: Math.floor(Date.now() / 1000),
      stats: {
        total: stats.total,
        correct: stats.correct,
        rate: stats.total ? Math.round((stats.correct / stats.total) * 100) : 0,
        last_at: stats.last_at,
      },
      profile,
      mastery,
      attempts,
      facts,
      daily,
      error_distribution: errorDist,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/memory/attempts?limit=50&student_id=me
export function memoryAttempts(req, res) {
  try {
    const sid = req.query.student_id || DEFAULT_STUDENT_ID;
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
    res.json({ attempts: getRecentAttempts(sid, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/memory/facts?limit=50&student_id=me
export function memoryFacts(req, res) {
  try {
    const sid = req.query.student_id || DEFAULT_STUDENT_ID;
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
    res.json({ facts: getMemoryFacts(sid, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/memory/consolidate — 手动触发一次语义画像固化（LLM）
export async function memoryConsolidate(req, res) {
  try {
    const sid = req.body?.student_id || DEFAULT_STUDENT_ID;
    const result = await consolidateStudent(sid);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
