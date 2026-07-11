// LLM-as-Judge: 对单个 turn 进行 5 维度质量评估
// 自动检测 API 格式（Anthropic / OpenAI 兼容），复用主对话模型的 API 配置
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_MODEL } from '../config.js';
import { resolveApiFormat } from '../vision.js';
import { insertEvalScore, getProblem } from '../db.js';

const JUDGE_MODEL = process.env.JUDGE_MODEL || CLAUDE_MODEL || 'claude-sonnet-4-20250514';

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

const JUDGE_SYSTEM_PROMPT = `你是一个小学数学 AI 助教的质量评估专家。请根据以下 trace 数据，对 AI 助教的回复质量进行 5 个维度的评分（1-5 分）。

评分维度：
1. non_disclosure（1-5）：学生模式下，AI 是否避免直接给出答案而是引导学生思考。5=完全没透露答案，1=直接给了答案。家长模式此项固定5分。
2. tutoring_strategy（1-5）：辅导策略是否恰当（引导而非代答、难度适配、循序渐进）。5=策略优秀，1=策略很差。
3. tool_correctness（1-5）：工具调用是否正确、合理（调用了合适的工具、参数正确、没有冗余调用）。5=工具使用完美，1=工具使用严重错误。无工具调用时给3分。
4. problem_quality（1-5）：AI 出题质量（难度适中、表达清晰、答案正确）。如果没有出题，给3分。
5. tone_interaction（1-5）：语气是否适合小学生（鼓励、耐心、不居高临下、不过度使用emoji）。5=语气完美，1=语气不当。

请严格以 JSON 格式输出，每个维度包含 score（整数1-5）和 comment（简短说明，不超过50字）：
{"non_disclosure":{"score":5,"comment":"未直接给出答案"},"tutoring_strategy":{"score":4,"comment":"引导较好"},"tool_correctness":{"score":3,"comment":"无工具调用"},"problem_quality":{"score":3,"comment":"未出题"},"tone_interaction":{"score":5,"comment":"语气友好鼓励"}}

不要输出任何其他内容，只输出 JSON。`;

/**
 * 对单个 turn 执行 LLM Judge 评估
 * @param {object} turn - chat_turns 表行
 * @param {string} sessionId - 会话 ID
 * @param {string} [currentProblemId] - 当前题目 ID
 * @returns {Promise<object>} 评估结果 { scores: {...}, raw: string }
 */
export async function judgeTurn(turn, sessionId, currentProblemId) {
  const { baseUrl, apiKey } = getApiConfig();
  if (!apiKey) throw new Error('LLM Judge 需要 API Key，请设置 ANTHROPIC_API_KEY');

  const apiFormat = resolveApiFormat();

  // 如果 resolveApiFormat 返回 anthropic 但 base URL 不是 anthropic.com，
  // 说明是第三方代理，需要检测是否实际支持 Anthropic 格式
  let effectiveFormat = apiFormat;
  if (effectiveFormat === 'anthropic' && baseUrl) {
    try {
      const hostname = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl).hostname;
      if (!/anthropic\.com$/i.test(hostname)) {
        // 非 Anthropic 官方域名，用 OpenAI 兼容格式
        effectiveFormat = 'openai';
      }
    } catch { /* ignore */ }
  }

  const role = turn.role || 'student';
  const userMsg = turn.user_message || '';
  const aiMsg = turn.ai_message || '';
  const toolCalls = JSON.parse(turn.tool_calls_json || '[]');

  let problemInfo = '';
  if (currentProblemId) {
    const p = getProblem(currentProblemId);
    if (p) {
      problemInfo = `当前题目：${p.text}\n正确答案：${p.answer}\n主题：${p.topic}`;
    }
  }

  const userPrompt = `请评估以下 AI 助教的回复质量：

模式：${role}
用户输入：${userMsg}
AI 回复：${aiMsg || '(AI 无回复)'}
工具调用：${toolCalls.length > 0 ? JSON.stringify(toolCalls.map(t => ({ name: t.name, input: t.input }))) : '无'}
${problemInfo ? '\n' + problemInfo : ''}

请按 5 个维度评分（1-5），只输出 JSON。`;

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
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    };
  } else {
    // OpenAI 兼容格式（SiliconFlow 等）
    url = /\/v\d+\//.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    };
    payload = {
      model: JUDGE_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  console.log(`[llm-judge] POST ${url} model=${JUDGE_MODEL} format=${effectiveFormat}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM Judge API 错误 ${resp.status}: ${text.slice(0, 200)}`);
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
    console.error('[llm-judge] failed to parse result:', rawText.slice(0, 300));
    return { scores: {}, raw: rawText };
  }

  // 持久化评分到 DB
  const dimensions = ['non_disclosure', 'tutoring_strategy', 'tool_correctness', 'problem_quality', 'tone_interaction'];
  for (const dim of dimensions) {
    const item = parsed[dim];
    if (item && typeof item.score === 'number') {
      insertEvalScore({
        turn_id: turn.id,
        session_id: sessionId,
        role,
        scorer: 'llm-judge',
        dimension: dim,
        value: item.score,
        data_type: 'numeric',
        comment: item.comment || '',
      });
    }
  }

  console.log(`[llm-judge] turn ${turn.id} scored: ${JSON.stringify(parsed)}`);
  return { scores: parsed, raw: rawText };
}

/**
 * 解析 LLM 返回的 JSON 评分结果
 */
function parseJudgeResult(text) {
  // 尝试直接 parse
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // 尝试从 markdown 代码块中提取
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch { /* continue */ }
  }

  // 尝试提取第一个 { ... } 块
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch { /* continue */ }
  }

  console.error('[llm-judge] failed to parse result:', text.slice(0, 200));
  return {};
}
