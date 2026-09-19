// 学生记忆读取 controller —— 学习档案页（student-memory.html）的数据源。
// 目标学生由鉴权中间件 resolveTargetStudent 解析并挂到 req.targetStudentId：
//   学生账号 → 只能是自己；家长 → 必须是已绑定的孩子；管理员 → 任意（须传 studentId）。
import {
  getStudentProfile, getTopicMastery, getRecentAttempts, getMemoryFacts,
  getAttemptStats, getDailyAccuracy, getErrorTypeDistribution, getScratchUsageStats,
} from '../db.js';
import { consolidateStudent } from '../memory/consolidate.js';

function targetId(req, res) {
  const sid = req.targetStudentId;
  if (!sid) {
    res.status(400).json({ error: '未指定学生（管理员需带 ?studentId=）' });
    return null;
  }
  return sid;
}

// GET /api/memory/overview?days=30[&studentId=]
export function memoryOverview(req, res) {
  try {
    const sid = targetId(req, res);
    if (!sid) return;
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
      // 草稿（动手演算）习惯：动笔率 + 动笔/不动笔作答的正确率对比
      scratch: getScratchUsageStats(sid),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/memory/attempts?limit=50[&studentId=]
export function memoryAttempts(req, res) {
  try {
    const sid = targetId(req, res);
    if (!sid) return;
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
    res.json({ attempts: getRecentAttempts(sid, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/memory/facts?limit=50[&studentId=]
export function memoryFacts(req, res) {
  try {
    const sid = targetId(req, res);
    if (!sid) return;
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit) || 50));
    res.json({ facts: getMemoryFacts(sid, limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/memory/consolidate — 手动触发一次语义画像固化（LLM）
export async function memoryConsolidate(req, res) {
  try {
    const sid = targetId(req, res);
    if (!sid) return;
    const result = await consolidateStudent(sid);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
