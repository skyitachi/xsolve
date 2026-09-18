// 学生记忆巩固（consolidation）：把碎片答题事件压缩成稳定的语义画像（student_profile）
//
// 类比认知科学里的「记忆巩固」：读取近期 student_attempts + 主题掌握度 + AI 主动记下的定性事实，
// 交给 LLM 归纳出难度水位 / 独立性 / 错因分布 / 偏好 / 画像综述，写回 student_profile（一行一个学生）。
// 同时刷新 topic_mastery 的时间衰减——长期未练的主题掌握度自然回落，避免"吃老本"。
//
// 复用 eval/student-eval.js 的 LLM 调用范式（getJudgeApiConfig + 双格式请求），
// 由 turnController.persistTurn() 每 MEMORY_CONSOLIDATE_INTERVAL 轮异步触发（不阻塞对话）。
import {
  getRecentAttempts, getTopicMastery, getStudentProfile, getMemoryFacts,
  getAttemptStats, applyMasteryDecay, upsertStudentProfile,
} from '../db.js';
import { callMemoryLLM, parseJSON } from './llm.js';

const DEFAULT_STUDENT_ID = 'me';
const MIN_ATTEMPTS = 3; // 数据太少不固化，避免凭 1~2 题下结论

const CONSOLIDATE_PROMPT = `你是一个小学数学学习分析师。请根据学生的答题记录与主题掌握度，归纳一份**稳定的学习画像**，供 AI 助教在新会话中参考。

请严格以 JSON 输出（不要 markdown 代码块、不要任何多余文字）：
{
  "level": "基础" | "巩固" | "挑战",
  "independence": "<一句话：学生做题的独立性（是否一遇难题就求提示）>",
  "error_patterns": { "计算": 0, "概念": 0, "审题": 0, "方法": 0 },
  "preferences": { "<偏好标签>": true },
  "narrative": "<60~120 字的画像综述：整体水平、薄弱与较强主题、主要错因、求助习惯与建议>"
}

判定口径：
- level：据整体正确率与题目难度水位——稳定在低正确率选"基础"，中等选"巩固"，正确率高且稳定选"挑战"。
- error_patterns：只填有把握的类别计数（据"错因"列统计）；无差错的类别填 0。
- preferences：仅在记录中确有体现时才写（如"喜欢画图""偏好口头讲解"），没有就给空对象 {}。
- narrative：面向 AI 助教的**行动建议**（该如何铺垫难度、优先巩固哪个主题、提示该给多细），不要罗列原始数据。
只输出 JSON。`;

function ruleLevelFromMastery(mastery) {
  const rows = mastery.filter((m) => (m.attempts || 0) > 0);
  if (!rows.length) return '巩固';
  const avg = rows.reduce((s, m) => s + (m.mastery || 0), 0) / rows.length;
  if (avg < 0.5) return '基础';
  if (avg >= 0.8) return '挑战';
  return '巩固';
}

function buildStatsText(mastery, attempts, stats) {
  const lines = [];
  const rate = stats.total ? Math.round((stats.correct / stats.total) * 100) : 0;
  lines.push(`累计练习 ${stats.total} 题，正确 ${stats.correct} 题（总正确率 ${rate}%）`);
  if (mastery.length) {
    lines.push('各主题掌握度：');
    for (const m of mastery) {
      lines.push(`  - ${m.topic}：掌握度 ${Math.round((m.mastery || 0) * 100)}%，共 ${m.attempts} 题，对 ${m.correct} 题`);
    }
  } else {
    lines.push('（暂无主题掌握度数据）');
  }
  lines.push('最近答题流水（新 → 旧，最多 40 条）：');
  for (const a of attempts.slice(0, 40)) {
    const day = new Date(a.created_at * 1000).toISOString().slice(0, 10);
    const mark = a.correct ? '✔正确' : `✘错误${a.error_type ? '（错因:' + a.error_type + '）' : ''}`;
    lines.push(`  - [${day}] ${a.topic || '未知主题'} ${mark} 提示${a.hint_count || 0}次`);
  }
  return lines.join('\n');
}

/**
 * 固化（consolidate）某学生的语义画像。
 * @param {string} studentId - 默认 'me'
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, decayed_topics?:number, profile?:object, llm_ok?:boolean, raw?:string}>}
 */
export async function consolidateStudent(studentId = DEFAULT_STUDENT_ID) {
  const sid = studentId || DEFAULT_STUDENT_ID;

  const stats = getAttemptStats(sid);
  if (stats.total < MIN_ATTEMPTS) {
    return { ok: false, skipped: true, reason: `作答不足（${stats.total}/${MIN_ATTEMPTS}）` };
  }

  // 先刷新时间衰减，再读掌握度，保证喂给 LLM 的是衰减后的结果
  const decayedTopics = applyMasteryDecay(sid);
  const mastery = getTopicMastery(sid);
  const attempts = getRecentAttempts(sid, 60);
  const facts = getMemoryFacts(sid, 20);
  const existing = getStudentProfile(sid);

  const userPrompt = [
    '学生累计答题统计与主题掌握度：',
    buildStatsText(mastery, attempts, stats),
    existing?.narrative ? `\n上一次画像综述（可参考，但请据当前数据更新）：\n${existing.narrative}` : '',
    facts.length ? `\nAI 曾记下的定性事实：\n${facts.map((f) => `  - [${f.kind}] ${f.content}`).join('\n')}` : '',
    '\n请据此输出学习画像 JSON。',
  ].filter(Boolean).join('\n');

  let raw = '';
  let parsed = null;
  try {
    raw = await callMemoryLLM(userPrompt, CONSOLIDATE_PROMPT, { tag: 'consolidate' });
    parsed = parseJSON(raw);
  } catch (e) {
    console.error('[consolidate] LLM failed:', e.message);
  }

  // 规则兜底：LLM 失败时仍写入 level（据掌握度推断），其余字段保持不动
  const profile = upsertStudentProfile({
    student_id: sid,
    level: parsed?.level || ruleLevelFromMastery(mastery),
    independence: parsed?.independence,
    error_patterns: parsed?.error_patterns,
    preferences: parsed?.preferences,
    narrative: parsed?.narrative,
  });

  const llmOk = !!parsed;
  console.log(`[consolidate] student=${sid} decayed_topics=${decayedTopics} llm_ok=${llmOk} level=${profile?.level}`);
  return { ok: true, decayed_topics: decayedTopics, profile, raw, llm_ok: llmOk };
}
