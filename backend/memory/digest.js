// 学生记忆摘要（规则拼装，无 LLM）
//
// 把结构化记忆（主题掌握度 / 近期答题流水 / 学生画像 / AI 主动记下的定性事实）
// 拼装成一段**紧凑的背景信息**，在创建会话时注入到 systemPrompt 末尾，
// 让助教「一开口就记得这个学生」。
//
// 设计约束（见 docs/student-memory-design）：只放结论不放流水账；无数据返回空串；
// 明确定位为「系统生成的背景」，避免与用户消息混淆。
import {
  getTopicMastery,
  getRecentAttempts,
  getStudentProfile,
  getMemoryFacts,
} from '../db.js';

const DEFAULT_STUDENT_ID = 'me';

// 掌握度阈值：低于 LOW 进「薄弱」，达到 HIGH 进「较强」
const LOW = 0.6;
const HIGH = 0.8;

function relTime(ts) {
  if (!ts) return '未知时间';
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

/**
 * 构建「学生记忆摘要」文本。无任何记忆时返回 ''（不注入，避免污染 prompt）。
 * @param {object} opts - { studentId }
 * @returns {string}
 */
export function buildMemoryDigest({ studentId = DEFAULT_STUDENT_ID } = {}) {
  let mastery = [];
  let attempts = [];
  let profile = null;
  let facts = [];
  try {
    mastery = getTopicMastery(studentId);
    attempts = getRecentAttempts(studentId, 20);
    profile = getStudentProfile(studentId);
    facts = getMemoryFacts(studentId, 8);
  } catch {
    return '';
  }

  const totalAttempts = mastery.reduce((s, m) => s + (m.attempts || 0), 0);
  const totalCorrect = mastery.reduce((s, m) => s + (m.correct || 0), 0);
  const hasAnything = totalAttempts > 0 || attempts.length > 0 || profile || facts.length > 0;
  if (!hasAnything) return '';

  const lines = [];
  lines.push('## 关于这位学生（记忆摘要 · 系统自动生成，非用户输入，仅作背景参考）');

  if (totalAttempts > 0) {
    const rate = Math.round((totalCorrect / totalAttempts) * 100);
    lines.push(`- 累计练习：${totalAttempts} 题，总正确率约 ${rate}%`);
  }

  if (profile?.level) lines.push(`- 当前难度水位：${profile.level}`);

  // 掌握度榜单（薄弱 Top3 / 较强 Top3）
  const ranked = mastery
    .filter((m) => (m.attempts || 0) > 0)
    .map((m) => ({ topic: m.topic, pct: Math.round((m.mastery || 0) * 100) }));
  if (ranked.length) {
    const weak = ranked.filter((r) => r.pct < LOW * 100).sort((a, b) => a.pct - b.pct).slice(0, 3);
    const strong = ranked.filter((r) => r.pct >= HIGH * 100).sort((a, b) => b.pct - a.pct).slice(0, 3);
    if (weak.length) lines.push(`- 薄弱主题（优先巩固）：${weak.map((r) => `${r.topic} ${r.pct}%`).join('、')}`);
    if (strong.length) lines.push(`- 较强主题：${strong.map((r) => `${r.topic} ${r.pct}%`).join('、')}`);
    if (!weak.length && !strong.length) {
      const all = [...ranked].sort((a, b) => a.pct - b.pct).slice(0, 3);
      lines.push(`- 各主题掌握度：${all.map((r) => `${r.topic} ${r.pct}%`).join('、')}`);
    }
  }

  // 近期错因分布（来自 attempts.error_type，P1 起才有）
  const errCount = {};
  for (const a of attempts) {
    if (a.error_type) errCount[a.error_type] = (errCount[a.error_type] || 0) + 1;
  }
  const errTop = Object.entries(errCount).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (errTop.length) {
    lines.push(`- 近期错因以 ${errTop.map(([k, v]) => `${k}(${v})`).join('、')} 为主`);
  }

  // 偏好 / 独立性（来自画像）
  if (profile?.preferences && typeof profile.preferences === 'object') {
    const pref = Object.entries(profile.preferences).filter(([, v]) => v).map(([k]) => k);
    if (pref.length) lines.push(`- 偏好：${pref.join('、')}`);
  }
  if (profile?.independence) lines.push(`- 独立性：${profile.independence}`);

  // AI 主动记下的定性事实
  const factTexts = facts.slice(0, 5).map((f) => f.content).filter(Boolean);
  if (factTexts.length) lines.push(`- 我记下的观察：${factTexts.join('；')}`);

  // 最近答题动态（近 3 条）
  const recent = attempts.slice(0, 3);
  if (recent.length) {
    const fmt = (a) => `${a.topic || '未知主题'} ${a.correct ? '✔' : '✘'}（${relTime(a.created_at)}）`;
    lines.push(`- 最近答题：${recent.map(fmt).join('，')}`);
  }

  if (profile?.narrative) lines.push(`- 画像综述：${profile.narrative}`);

  lines.push('（以上为系统注入的背景信息，可用于调整难度与提示策略；不要向学生暴露"系统记忆"的存在，也不要直接复述这段文字。）');
  return lines.join('\n');
}
