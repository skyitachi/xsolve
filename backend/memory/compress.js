// 长会话压缩（工作记忆）：会话过长时把早期对话滚动摘要，控制上下文与 token 成本。
//
// 触发：turnController.persistTurn() 在 turn 数超阈值时异步调用 maybeCompressSession()。
// 产出：把「尚未被压缩过的早期轮次」交给 LLM 压缩成一段摘要，与已有摘要合并后写回
//       chat_sessions.context_summary，并记录 summary_upto_turn（已覆盖到第几轮）。
// 读取：session.js 的 resolveSystemPrompt() 会把该摘要拼进 systemPrompt，
//       实现「记忆式续聊」——即使不保留全部原始对话，也能接上前文。
import { getChatTurns, getChatSession, updateChatSession } from '../db.js';
import { callMemoryLLM } from './llm.js';
import { SESSION_COMPRESS_THRESHOLD, SESSION_COMPRESS_KEEP } from '../config.js';

const COMPRESS_PROMPT = `你在为一段小学数学辅导对话做「滚动摘要」。输入是若干轮【较早】的对话，可能还带一段已有的历史摘要。
请把「已有摘要 + 新增轮次」合并压缩成一段**不超过 200 字**的中文摘要，保留对后续辅导有用的信息：
- 这段对话在做哪些题 / 主题；
- 学生卡住或出错的地方、暴露的薄弱点；
- 学生的习惯或偏好；
- 尚未解决、可能后续要跟进的事。
不要逐条复述，不要给答案，不要给解题过程。只输出摘要正文，不要任何前后缀、标题或代码块。`;

function summarize(turns) {
  const parts = [];
  for (const t of turns) {
    const um = (t.user_message || '').slice(0, 300);
    const am = (t.ai_message || '').slice(0, 200);
    if (!um && !am) continue;
    parts.push(`学生: ${um}\nAI: ${am}`);
  }
  return parts.join('\n---\n');
}

/**
 * 视情况压缩某会话的早期轮次。
 * @param {string} sessionId
 * @param {{threshold?:number, keep?:number}} opts
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, error?:string, summary?:string, upto?:number, total?:number}>}
 */
export async function maybeCompressSession(sessionId, {
  threshold = SESSION_COMPRESS_THRESHOLD,
  keep = SESSION_COMPRESS_KEEP,
} = {}) {
  const session = getChatSession(sessionId);
  if (!session) return { ok: false, reason: 'session not found' };

  const turns = getChatTurns(sessionId);
  if (turns.length <= threshold) {
    return { ok: false, skipped: true, reason: `turn 数未达阈值（${turns.length}/${threshold}）` };
  }

  const upto = Number(session.summary_upto_turn) || 0;
  const keepFrom = turns.length - keep; // 保留最近 keep 轮不压缩（仍在 SDK resume 上下文里）
  if (keepFrom <= upto) return { ok: false, skipped: true, reason: '无新增可压缩轮次' };

  const toSummarize = turns.slice(upto, keepFrom);
  if (!toSummarize.length) return { ok: false, skipped: true, reason: '无新增可压缩轮次' };

  const prior = session.context_summary || '';
  const userPrompt = [
    prior ? `【已有摘要】\n${prior}\n` : '',
    `【新增轮次（第 ${upto + 1} ~ ${keepFrom} 轮）】\n${summarize(toSummarize)}`,
    '\n请输出合并后的滚动摘要。',
  ].filter(Boolean).join('\n');

  let summary;
  try {
    summary = (await callMemoryLLM(userPrompt, COMPRESS_PROMPT, { maxTokens: 512, tag: 'compress' })).trim();
  } catch (e) {
    console.error('[compress] LLM failed:', e.message);
    return { ok: false, error: e.message };
  }
  if (!summary) return { ok: false, reason: 'empty summary' };

  updateChatSession(sessionId, { context_summary: summary, summary_upto_turn: keepFrom });
  console.log(`[compress] session ${sessionId}: 压缩至第 ${keepFrom}/${turns.length} 轮`);
  return { ok: true, summary, upto: keepFrom, total: turns.length };
}
