// Student-level evaluation: 评估学生能力而非 AI 质量
// 参考 docs/student-eval-design/student-eval-design.html
// 5 个维度: accuracy, independence, thinking_quality, engagement, error_type
// 规则计算 + LLM 评估混合模式
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_MODEL } from '../config.js';
import { resolveApiFormat } from '../vision.js';
import {
  getChatTurns, getChatSession, getProblem,
  insertSessionEvalScore, deleteSessionEvalScores,
} from '../db.js';

const JUDGE_MODEL = process.env.JUDGE_MODEL || CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const MIN_TURNS_FOR_EVAL = 2;

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

const STUDENT_EVAL_PROMPT = `你是一个小学数学教育评估专家。请根据以下整个 session 的对话记录，对学生的学习能力和表现进行 5 个维度的评估。

评估维度（1-5 分）：
1. accuracy（1-5）：学生答题正确率。5=全部正确，3=部分正确，1=全部错误。如果学生未提交答案，给3分。
2. independence（1-5）：答题独立性。5=完全独立完成，3=需要少量提示，1=高度依赖AI提示。评估学生主动请求提示的频率。
3. thinking_quality（1-5）：思维过程质量。5=思路清晰、步骤完整，3=有基本思路但不完整，1=直接写答案无过程或思路混乱。
4. engagement（1-5）：学习参与度。5=高度投入、主动提问"为什么"，3=正常参与，1=被动应付或只说"不会"。
5. error_type（分类值）：如果学生答错过，判断主要错误类型。取值：calculation（计算错误）、concept（概念错误）、comprehension（审题错误）、method（方法错误）、none（未答错）。

请严格以 JSON 格式输出：
{"accuracy":{"score":4,"comment":"答对了2题中1题"},"independence":{"score":3,"comment":"请求了2次提示"},"thinking_quality":{"score":3,"comment":"有步骤但不完整"},"engagement":{"score":4,"comment":"主动提问"},"error_type":{"score":0,"comment":"concept"}}

注意：error_type 的 score 固定为 0，comment 填写错误类型（calculation/concept/comprehension/method/none）。
不要输出任何其他内容，只输出 JSON。`;

// ========== 规则计算 ==========

const HINT_PATTERNS = /不会|不懂|没思路|不知道怎么做|提示|帮帮我|帮|教我|答案是什么|怎么做|看不懂|想不出来|给点(思路|提示|帮助)/i;
const ACTIVE_QUESTION_PATTERNS = /为什么|怎么样|是不是|对吗|可以这样吗|为什么不对|理解错了吗|哪里错了|什么原理/i;

function calculateRuleMetrics(turns, session) {
  const role = session.role || 'student';
  let hintRequests = 0;
  let activeQuestions = 0;
  let totalMessages = 0;
  let totalDuration = 0;
  let errorTurns = 0;

  for (const t of turns) {
    const msg = (t.user_message || '').toLowerCase();
    totalMessages++;
    totalDuration += t.duration_ms || 0;
    if (t.error) errorTurns++;

    // 统计提示请求
    if (HINT_PATTERNS.test(msg)) hintRequests++;

    // 统计主动提问
    if (ACTIVE_QUESTION_PATTERNS.test(msg)) activeQuestions++;

    // 统计工具调用中的 hint 请求
    const tools = JSON.parse(t.tool_calls_json || '[]');
    for (const tc of tools) {
      if (tc.name && tc.name.includes('ability_report')) hintRequests++;
    }
  }

  // 独立性: 0 次提示 = 5 分，每次提示扣 1 分，最低 1 分
  const independenceRule = Math.max(1, 5 - hintRequests);

  // 参与度: 基于主动提问比例 + 消息数量
  const activeRatio = totalMessages > 0 ? activeQuestions / totalMessages : 0;
  let engagementRule = 3; // 基础分
  if (activeRatio >= 0.3) engagementRule = 5;
  else if (activeRatio >= 0.15) engagementRule = 4;
  else if (activeRatio === 0 && totalMessages > 3) engagementRule = 2;

  return {
    hint_requests: hintRequests,
    active_questions: activeQuestions,
    total_messages: totalMessages,
    total_duration_s: Math.round(totalDuration / 1000),
    error_turns: errorTurns,
    independence_rule: independenceRule,
    engagement_rule: engagementRule,
  };
}

// ========== LLM 评估 ==========

function buildConversationSummary(turns, session, problem) {
  const parts = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const lines = [`[Turn ${i + 1}]`];
    if (t.user_message) lines.push(`学生: ${t.user_message.slice(0, 400)}`);
    if (t.ai_message) lines.push(`AI: ${t.ai_message.slice(0, 300)}`);
    const tools = JSON.parse(t.tool_calls_json || '[]');
    if (tools.length > 0) {
      lines.push(`工具调用: ${tools.map(tc => tc.name).join(', ')}`);
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n---\n');
}

async function callLLM(userPrompt, systemPrompt) {
  const { baseUrl, apiKey } = getApiConfig();
  if (!apiKey) throw new Error('Student Eval 需要 API Key');

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
      system: systemPrompt,
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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  console.log(`[student-eval] POST ${url} model=${JUDGE_MODEL} format=${effectiveFormat}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Student Eval API 错误 ${resp.status}: ${text.slice(0, 200)}`);
  }

  const body = await resp.json();
  if (effectiveFormat === 'anthropic') {
    return body.content?.[0]?.text || '';
  } else {
    return body.choices?.[0]?.message?.content || '';
  }
}

function parseJudgeResult(text) {
  try { return JSON.parse(text); } catch { /* continue */ }
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* continue */ }
  }
  return {};
}

// ========== 主评估函数 ==========

export async function evalStudent(sessionId) {
  const session = getChatSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const turns = getChatTurns(sessionId);
  if (turns.length < MIN_TURNS_FOR_EVAL) {
    return { scores: {}, raw: `turn 数不足 (${turns.length}/${MIN_TURNS_FOR_EVAL})`, turn_count: turns.length };
  }

  const role = session.role || 'student';

  // 获取题目信息
  let problem = null;
  if (session.current_problem_id) {
    problem = getProblem(session.current_problem_id);
  }

  // 1. 规则计算
  const ruleMetrics = calculateRuleMetrics(turns, session);

  // 2. LLM 评估
  const conversationSummary = buildConversationSummary(turns, session, problem);
  let problemInfo = '';
  if (problem) {
    problemInfo = `当前题目：${problem.text}\n正确答案：${problem.answer}\n主题：${problem.topic}`;
  }

  const userPrompt = `请评估以下学生的学习表现：

模式：${role}
Session ID：${sessionId}
Turn 总数：${turns.length}
总耗时：${ruleMetrics.total_duration_s} 秒
提示请求次数：${ruleMetrics.hint_requests}
主动提问次数：${ruleMetrics.active_questions}

${problemInfo ? `【题目信息】\n${problemInfo}\n` : ''}

【完整对话记录（已截断每条 400 字）】
${conversationSummary}

请根据以上对话记录，按 5 个维度评估学生能力，只输出 JSON。`;

  let llmResult = {};
  let rawText = '';
  try {
    rawText = await callLLM(userPrompt, STUDENT_EVAL_PROMPT);
    llmResult = parseJudgeResult(rawText);
  } catch (err) {
    console.error('[student-eval] LLM eval failed:', err.message);
    // LLM 失败时使用规则计算的结果作为 fallback
  }

  // 3. 合并结果：优先使用 LLM 结果，fallback 到规则计算
  const accuracy = llmResult.accuracy?.score ?? 3;
  const accuracyComment = llmResult.accuracy?.comment || '未评估';
  const independence = llmResult.independence?.score ?? ruleMetrics.independence_rule;
  const independenceComment = llmResult.independence?.comment || `请求了 ${ruleMetrics.hint_requests} 次提示`;
  const thinkingQuality = llmResult.thinking_quality?.score ?? 3;
  const thinkingComment = llmResult.thinking_quality?.comment || '未评估';
  const engagement = llmResult.engagement?.score ?? ruleMetrics.engagement_rule;
  const engagementComment = llmResult.engagement?.comment || `主动提问 ${ruleMetrics.active_questions} 次`;
  const errorType = llmResult.error_type?.comment || 'none';
  const errorTypeComment = errorType;

  // 4. 清除旧的学生评估分数
  deleteSessionEvalScores(sessionId, 'student-eval');

  // 5. 持久化到 DB
  const scoreEntries = [
    { dimension: 'accuracy', value: accuracy, comment: accuracyComment },
    { dimension: 'independence', value: independence, comment: independenceComment },
    { dimension: 'thinking_quality', value: thinkingQuality, comment: thinkingComment },
    { dimension: 'engagement', value: engagement, comment: engagementComment },
    { dimension: 'error_type', value: 0, comment: errorTypeComment },
    { dimension: 'hint_requests', value: ruleMetrics.hint_requests, comment: '提示请求次数' },
    { dimension: 'active_questions', value: ruleMetrics.active_questions, comment: '主动提问次数' },
    { dimension: 'total_duration_s', value: ruleMetrics.total_duration_s, comment: 'session 总耗时（秒）' },
  ];

  // 如果有题目信息，记录按 topic 的正确率
  if (problem) {
    const isCorrect = accuracy >= 4 ? 1 : 0;
    scoreEntries.push({
      dimension: 'accuracy_by_topic',
      value: isCorrect,
      comment: problem.topic,
    });
  }

  for (const entry of scoreEntries) {
    insertSessionEvalScore({
      session_id: sessionId,
      role,
      scorer: 'student-eval',
      dimension: entry.dimension,
      value: entry.value,
      data_type: entry.dimension === 'error_type' ? 'categorical' : 'numeric',
      comment: entry.comment,
      turn_count: turns.length,
    });
  }

  const result = {
    accuracy: { score: accuracy, comment: accuracyComment },
    independence: { score: independence, comment: independenceComment },
    thinking_quality: { score: thinkingQuality, comment: thinkingComment },
    engagement: { score: engagement, comment: engagementComment },
    error_type: errorType,
    rule_stats: {
      hint_requests: ruleMetrics.hint_requests,
      active_questions: ruleMetrics.active_questions,
      total_duration_s: ruleMetrics.total_duration_s,
      total_messages: ruleMetrics.total_messages,
    },
    raw: rawText,
    turn_count: turns.length,
  };

  console.log(`[student-eval] session ${sessionId} evaluated: accuracy=${accuracy} independence=${independence} thinking=${thinkingQuality} engagement=${engagement} error_type=${errorType}`);
  return result;
}
