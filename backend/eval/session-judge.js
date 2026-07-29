// Session-level LLM Judge: 对整个 session 的辅导质量进行整体评估
// 与 turn-level judge 并行，关注跨 turn 的连续性、适应性和整体效果
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_MODEL } from '../config.js';
import { resolveApiFormat } from '../vision.js';
import {
  getChatTurns, getChatSession, getProblem,
  getActivePromptVersion,
  insertSessionEvalScore, deleteSessionEvalScores,
} from '../db.js';

const JUDGE_MODEL = process.env.JUDGE_MODEL || CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// Session-level 评估的最小 turn 数（太少没有评估意义）
const MIN_TURNS_FOR_SESSION_EVAL = 3;

function getApiConfig() {
  let baseUrl = process.env.ANTHROPIC_BASE_URL;
  let apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl || !apiKey) {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = s.env || {};
        baseUrl = baseUrl || env.ANTHROPIC_BASE_URL;
        apiKey = apiKey || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
      }
    } catch { /* ignore */ }
  }
  if (!baseUrl) baseUrl = 'https://api.anthropic.com';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

const SESSION_JUDGE_PROMPT = `你是一个小学数学 AI 助教的质量评估专家。请根据以下整个 session 的对话记录，对 AI 助教的整体辅导质量进行 5 个维度的评分（1-5 分）。

评分维度：
1. continuity（1-5）：AI 是否在整个 session 中保持上下文连贯。5=完美引用之前的对话内容，1=完全脱节。
2. adaptation（1-5）：AI 是否根据学生表现动态调整策略（如学生卡壳时增加引导、学生掌握后提高难度）。5=优秀适应性，1=一成不变。
3. session_completeness（1-5）：session 是否达成了教学目标（问题被解决、学生理解了关键概念）。5=完全达成，1=毫无进展。
4. consistency（1-5）：AI 的语气、难度、风格是否在整个 session 中保持一致。5=高度一致，1=前后矛盾。
5. student_engagement（1-5）：从对话记录看，学生的参与度如何。5=高度投入主动思考，1=完全被动或走神。

请严格以 JSON 格式输出，每个维度包含 score（整数1-5）和 comment（简短说明，不超过80字）：
{"continuity":{"score":5,"comment":"AI多次引用学生之前的回答"},"adaptation":{"score":4,"comment":"根据学生错误调整了引导方式"},"session_completeness":{"score":4,"comment":"问题最终解决但过程略长"},"consistency":{"score":5,"comment":"语气风格一致"},"student_engagement":{"score":4,"comment":"学生积极参与但偶尔依赖提示"}}

不要输出任何其他内容，只输出 JSON。`;

/**
 * 对整个 session 执行 LLM Judge 评估
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<object>} 评估结果 { scores: {...}, raw: string, turn_count: number }
 */
export async function judgeSession(sessionId) {
  const { baseUrl, apiKey } = getApiConfig();
  if (!apiKey) throw new Error('Session Judge 需要 API Key，请设置 ANTHROPIC_API_KEY');

  const session = getChatSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const turns = getChatTurns(sessionId);
  if (turns.length < MIN_TURNS_FOR_SESSION_EVAL) {
    return { scores: {}, raw: `turn 数不足 (${turns.length}/${MIN_TURNS_FOR_SESSION_EVAL})，跳过 session 评估`, turn_count: turns.length };
  }

  const role = session.role || 'student';

  // 聚合 session 上下文
  const apiFormat = resolveApiFormat();
  let effectiveFormat = apiFormat;
  if (effectiveFormat === 'anthropic' && baseUrl) {
    try {
      const hostname = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl).hostname;
      if (!/anthropic\.com$/i.test(hostname)) {
        effectiveFormat = 'openai';
      }
    } catch { /* ignore */ }
  }

  // 构建 session 对话摘要
  const conversationSummary = turns.map((t, i) => {
    const parts = [`[Turn ${i + 1}]`];
    if (t.user_message) parts.push(`学生: ${t.user_message.slice(0, 500)}`);
    if (t.ai_message) parts.push(`AI: ${t.ai_message.slice(0, 500)}`);
    const tools = JSON.parse(t.tool_calls_json || '[]');
    if (tools.length > 0) {
      parts.push(`工具调用: ${tools.map(tc => tc.name).join(', ')}`);
    }
    if (t.error) parts.push(`(错误: ${t.error.slice(0, 100)})`);
    return parts.join('\n');
  }).join('\n---\n');

  // 题目信息
  let problemInfo = '';
  if (session.current_problem_id) {
    const p = getProblem(session.current_problem_id);
    if (p) {
      problemInfo = `当前题目：${p.text}\n正确答案：${p.answer}\n主题：${p.topic}`;
    }
  }

  // 聚合统计
  const totalTokens = turns.reduce((acc, t) => ({
    input: acc.input + (t.input_tokens || 0),
    output: acc.output + (t.output_tokens || 0),
  }), { input: 0, output: 0 });
  const totalDuration = turns.reduce((acc, t) => acc + (t.duration_ms || 0), 0);
  const errorTurns = turns.filter(t => t.error).length;

  const userPrompt = `请评估以下 AI 助教在整个 session 中的辅导质量：

模式：${role}
Session ID：${sessionId}
Turn 总数：${turns.length}
总耗时：${(totalDuration / 1000).toFixed(1)} 秒
Token 消耗：输入 ${totalTokens.input}，输出 ${totalTokens.output}
错误 turn 数：${errorTurns}

${problemInfo ? `【题目信息】\n${problemInfo}\n` : ''}

【完整对话记录（已截断每条 500 字）】
${conversationSummary}

请根据以上完整 session 的对话记录，按 5 个维度评分（1-5），只输出 JSON。`;

  // 构建请求
  let url, headers, payload;
  if (effectiveFormat === 'anthropic') {
    url = `${baseUrl}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    payload = {
      model: JUDGE_MODEL,
      max_tokens: 1024,
      system: SESSION_JUDGE_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    };
  } else {
    url = /\/v\d+\//.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    };
    payload = {
      model: JUDGE_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SESSION_JUDGE_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  console.log(`[session-judge] POST ${url} model=${JUDGE_MODEL} format=${effectiveFormat} session=${sessionId} turns=${turns.length}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Session Judge API 错误 ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = await resp.json();
  let rawText = '';
  if (effectiveFormat === 'anthropic') {
    rawText = body.content?.[0]?.text || '';
  } else {
    rawText = body.choices?.[0]?.message?.content || '';
  }

  const parsed = parseJudgeResult(rawText);

  if (Object.keys(parsed).length === 0) {
    console.error('[session-judge] failed to parse result:', rawText.slice(0, 300));
    return { scores: {}, raw: rawText, turn_count: turns.length };
  }

  // 清除旧的 session-judge 评分（避免重复）
  deleteSessionEvalScores(sessionId, 'session-judge');

  // 持久化到 DB
  const dimensions = ['continuity', 'adaptation', 'session_completeness', 'consistency', 'student_engagement'];
  for (const dim of dimensions) {
    const item = parsed[dim];
    if (item && typeof item.score === 'number') {
      insertSessionEvalScore({
        session_id: sessionId,
        role,
        scorer: 'session-judge',
        dimension: dim,
        value: item.score,
        data_type: 'numeric',
        comment: item.comment || '',
        turn_count: turns.length,
      });
    }
  }

  // 同时写入规则计算的统计维度
  insertSessionEvalScore({
    session_id: sessionId,
    role,
    scorer: 'rule',
    dimension: 'turn_count',
    value: turns.length,
    data_type: 'numeric',
    comment: 'session 总 turn 数',
    turn_count: turns.length,
  });
  insertSessionEvalScore({
    session_id: sessionId,
    role,
    scorer: 'rule',
    dimension: 'total_duration_s',
    value: Math.round(totalDuration / 1000),
    data_type: 'numeric',
    comment: 'session 总耗时（秒）',
    turn_count: turns.length,
  });
  insertSessionEvalScore({
    session_id: sessionId,
    role,
    scorer: 'rule',
    dimension: 'error_rate',
    value: turns.length > 0 ? Math.round((errorTurns / turns.length) * 100) / 100 : 0,
    data_type: 'numeric',
    comment: `错误 turn 占比 (${errorTurns}/${turns.length})`,
    turn_count: turns.length,
  });

  console.log(`[session-judge] session ${sessionId} scored: ${JSON.stringify(parsed)}`);
  return { scores: parsed, raw: rawText, turn_count: turns.length };
}

/**
 * 解析 LLM 返回的 JSON 评分结果
 */
function parseJudgeResult(text) {
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch { /* continue */ }
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* continue */ }
  }

  return {};
}
