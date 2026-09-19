// 记忆系统共用的 LLM 调用封装。
// 复用 eval 的 judge 配置（getJudgeApiConfig）+ 双格式请求（Anthropic / OpenAI 兼容），
// 供 consolidate（固化画像）与 compress（会话压缩）复用，避免重复代码。
import { getJudgeApiConfig } from '../api-config.js';
import { resolveApiFormat } from '../vision.js';

// 从 LLM 输出里尽力抽出 JSON（容忍 ```json 围栏与前后噪声）
export function parseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* continue */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* continue */ } }
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* continue */ } }
  return null;
}

/**
 * 调用 LLM（judge 配置）。
 * @param {string} userPrompt
 * @param {string} systemPrompt
 * @param {{maxTokens?:number, tag?:string}} opts
 * @returns {Promise<string>}
 */
export async function callMemoryLLM(userPrompt, systemPrompt, { maxTokens = 1024, tag = 'memory' } = {}) {
  const { baseUrl, apiKey } = getJudgeApiConfig();
  if (!apiKey) throw new Error('记忆系统需要 API Key（CLAUDE_API_KEY / ANTHROPIC_API_KEY）');

  // 必须把实际要请求的 baseUrl 传进去：无参调用会被 VISION_* 配置污染，
  // 而「非官方 anthropic.com 就降级 openai」的粗判会把 DeepSeek 的 /anthropic 网关
  // 打到 /v1/chat/completions 上（实测 404，而 /v1/messages 是 200）。详见 vision.js。
  // 这条路径出错是**静默**的：consolidate / compress 都有规则兜底，调用失败只会悄悄降级。
  const effectiveFormat = resolveApiFormat(baseUrl);
  const model = process.env.JUDGE_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

  let url, headers, payload;
  if (effectiveFormat === 'anthropic') {
    url = `${baseUrl}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    payload = { model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] };
  } else {
    url = /\/v\d+\//.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers = { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` };
    payload = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
  }

  console.log(`[${tag}] POST ${url} model=${model} format=${effectiveFormat}`);

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`[${tag}] API 错误 ${resp.status}: ${text.slice(0, 200)}`);
  }
  const body = await resp.json();
  return effectiveFormat === 'anthropic'
    ? (body.content?.[0]?.text || '')
    : (body.choices?.[0]?.message?.content || '');
}
