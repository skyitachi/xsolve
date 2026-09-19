// 视觉识别子代理：调用视觉模型识别图片（题目OCR + 草稿手写识别）
// 支持 Anthropic Messages API 格式和 OpenAI Chat Completions 格式
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VISION_SUBAGENT_PROMPT, VISION_TIMEOUT_MS, VISION_MAX_TOKENS } from './config.js';

// API 配置读取（环境变量 + ~/.claude/settings.json）
// 视觉子代理的 API_KEY / BASE_URL 可与主对话模型分开配置：
//   - 单独配置了 VISION_API_KEY / VISION_BASE_URL 时优先使用
//   - 否则继承主对话模型的配置（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 等）
export function getVisionApiConfig() {
  let baseUrl = process.env.VISION_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || process.env.OPENAI_BASE_URL;
  let apiKey = process.env.VISION_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.OPENAI_API_KEY;

  if (!baseUrl || !apiKey) {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = s.env || {};
        baseUrl = baseUrl || env.VISION_BASE_URL || env.ANTHROPIC_BASE_URL;
        apiKey = apiKey || env.VISION_API_KEY || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
      }
    } catch { /* ignore */ }
  }
  if (!baseUrl) baseUrl = 'https://api.anthropic.com';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

// 已知只提供 OpenAI 兼容协议的平台域名。
// 这些地址上不存在 Anthropic 的 /v1/messages，必须走 /v1/chat/completions。
// 用途：即使漏配 VISION_API_FORMAT，也能按地址自动纠偏 ——
// 历史上踩过这个坑：VISION_API_FORMAT=openai 被注释掉后，推断成 anthropic，
// 请求全打到 SiliconFlow 的 /v1/messages 上，视觉识别整体不可用。
const OPENAI_COMPATIBLE_HOSTS = [
  'api.siliconflow.cn',
  'api.siliconflow.com',
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'open.bigmodel.cn',
  'ark.cn-beijing.volces.com',
  'api.moonshot.cn',
  'api.openai.com',
  'api.groq.com',
  'openrouter.ai',
  'api.together.xyz',
];

/** 地址是否属于「只支持 OpenAI 兼容协议」的平台 */
export function isOpenAiCompatibleUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    // 显式带 /anthropic 路径的一律按 anthropic 处理（如 https://api.deepseek.com/anthropic）
    if (/\/anthropic\b/i.test(u.pathname)) return false;
    const host = u.hostname.toLowerCase();
    return OPENAI_COMPATIBLE_HOSTS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * 判断应该使用哪种 API 格式
 * - 默认使用 Anthropic 格式（因为主 SDK 只支持 Anthropic 格式，代理必须兼容此格式）
 * - 设置 VISION_API_FORMAT=openai / anthropic 可强制指定（最高优先级）
 * - 传入 baseUrl 时，若该地址属于已知的 OpenAI 兼容平台，自动判为 openai
 * - 视觉单独配置了 VISION_BASE_URL 时，默认 anthropic
 * - 未单独配置视觉地址时：只设了 OPENAI_BASE_URL 而没设 ANTHROPIC_BASE_URL，使用 OpenAI 格式
 *
 * @param {string} [baseUrl] 实际要请求的地址；传入可让判断更准确（推荐视觉/判卷调用点传）
 */
export function resolveApiFormat(baseUrl) {
  const explicit = process.env.VISION_API_FORMAT;
  if (explicit === 'openai') return 'openai';
  if (explicit === 'anthropic') return 'anthropic';
  if (baseUrl && isOpenAiCompatibleUrl(baseUrl)) return 'openai';
  if (process.env.VISION_BASE_URL) return 'anthropic';
  if (process.env.OPENAI_BASE_URL && !process.env.ANTHROPIC_BASE_URL) return 'openai';
  return 'anthropic';
}

/**
 * 解析视觉模型名称
 * 优先级：
 * 1. VISION_MODEL 环境变量（显式指定）
 * 2. Anthropic 格式下：CLAUDE_MODEL（复用主对话模型，Claude 原生支持视觉）
 * 3. Anthropic 官方 API 默认：claude-sonnet-4-20250514
 * 4. 其他情况：返回 null（需报错提示用户设置）
 */
function resolveVisionModel(apiFormat, baseUrl) {
  if (process.env.VISION_MODEL) return process.env.VISION_MODEL;

  const isOfficialAnthropic = /anthropic\.com$/i.test(new URL(baseUrl).hostname);

  if (apiFormat === 'anthropic') {
    if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
    if (isOfficialAnthropic) return 'claude-sonnet-4-20250514';
    return null;
  }
  return null; // OpenAI 格式必须显式指定
}

/**
 * 调用视觉模型识别图片
 * @param {string} imageDataUrl - data:image/...;base64,... 格式
 * @param {Function} emit - UI事件推送函数 (event, data) => void
 * @param {string} [customPrompt] - 自定义Prompt（不传则使用题目识别默认Prompt）
 * @returns {Promise<string>} 识别结果文本
 */
export async function runVisionHttp(imageDataUrl, emit, customPrompt, opts = {}) {
  const m = String(imageDataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('invalid image data url');
  const mediaType = m[1], base64Data = m[2];

  const { baseUrl, apiKey } = getVisionApiConfig();
  if (!apiKey) throw new Error('未找到 API Key。请设置 VISION_API_KEY 或 ANTHROPIC_API_KEY 环境变量。');

  const apiFormat = resolveApiFormat(baseUrl);
  const model = resolveVisionModel(apiFormat, baseUrl);

  if (!model) {
    if (apiFormat === 'openai') {
      throw new Error(
        '使用 OpenAI 兼容格式时必须指定视觉模型。\n' +
        '请设置环境变量 VISION_MODEL，例如：\n' +
        '  VISION_MODEL=Pro/Qwen/Qwen2.5-VL-7B-Instruct\n' +
        '（SiliconFlow 等平台可用的视觉模型通常以 VL/VLM 结尾）'
      );
    }
    throw new Error(
      '使用自定义 API 代理时必须指定模型。\n' +
      '请设置 CLAUDE_MODEL（主对话+视觉共用，推荐）或 VISION_MODEL（单独指定视觉模型）：\n' +
      '  CLAUDE_MODEL=claude-sonnet-4-20250514\n' +
      `当前 API 地址: ${baseUrl}`
    );
  }

  const isScratch = !!customPrompt;
  const sysPrompt = customPrompt || VISION_SUBAGENT_PROMPT;
  const userPrompt = isScratch
    ? '请识别图片中的手写内容，按指定的JSON格式直接输出结果。'
    : '请识别这张小学数学题图片，按指定格式输出。';

  if (emit) emit('ui_event', { type: 'vision_subagent_started', model, format: apiFormat });

  const t0 = Date.now();
  // 视觉平台会长时间不返回；必须带超时，否则调用方
  // （如 turnController 的草稿自动识别）会被永久挂住。
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : VISION_TIMEOUT_MS;

  // 组装请求（额外参数用于「关掉推理」重试）
  let url, headers, basePayload;
  if (apiFormat === 'anthropic') {
    url = `${baseUrl}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };
    basePayload = {
      model,
      max_tokens: VISION_MAX_TOKENS,
      system: sysPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: userPrompt }
        ]
      }]
    };
  } else {
    const promptText = sysPrompt + '\n\n' + userPrompt;
    url = /\/v\d+\//.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`
    };
    basePayload = {
      model,
      max_tokens: VISION_MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: promptText }
        ]
      }]
    };
  }

  async function postOnce(extra) {
    const payload = extra ? { ...basePayload, ...extra } : basePayload;
    let timedOut = false;
    const ac = new AbortController();
    const to = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
    } catch (e) {
      if (timedOut || e.name === 'AbortError') {
        console.error(`[vision] timeout after ${timeoutMs}ms (model=${model})`);
        const err = new Error(`视觉 API 超时：${timeoutMs}ms 内未返回（模型 ${model}）`);
        err.code = 'VISION_TIMEOUT';
        throw err;
      }
      console.error('[vision] network error', e.message);
      const err = new Error(`视觉 API 网络错误: ${e.message}\n地址: ${baseUrl}, 模型: ${model}`);
      err.code = 'VISION_NETWORK';
      throw err;
    } finally {
      clearTimeout(to);
    }
    const text = await resp.text();
    return { resp, body: text };
  }

  // 解析响应体 → 文本 + 诊断信息
  function extract(body) {
    let text = '';
    let finishReason = null;
    let reasoningChars = 0;
    let parsed = false;
    try {
      const j = JSON.parse(body);
      parsed = true;
      if (apiFormat === 'anthropic') {
        for (const block of (j.content || [])) {
          if (block.type === 'text' && block.text) text += block.text;
        }
      } else {
        const msg = j.choices?.[0]?.message || {};
        const content = msg.content;
        if (Array.isArray(content)) {
          text = content.filter(b => b.type === 'text').map(b => b.text).join('');
        } else {
          text = content || '';
        }
        finishReason = j.choices?.[0]?.finish_reason || null;
        // 推理模型把额度全花在思考上时 content 为空，这里留个指纹用于判断
        reasoningChars = String(msg.reasoning_content || '').length;
      }
    } catch {
      text = body;
    }
    text = (text || '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();
    return { text, parsed, finishReason, reasoningChars };
  }

  function httpError(resp, body) {
    let detail = body.slice(0, 1500);
    try {
      const j = JSON.parse(body);
      const msg = j.error?.message || j.message || JSON.stringify(j.error || j);
      if (/not a VLM|not.*vision|VLM|not support.*image|does not support/i.test(msg)) {
        detail = `模型 "${model}" 不支持图片识别。\n请确认该模型支持视觉输入，或设置 VISION_MODEL 指定视觉模型。\n如果代理是 Anthropic 兼容的，Claude 模型都支持视觉。\n原始错误：${msg}`;
      } else if (/model.*not found|invalid model|unknown model|model.*exist/i.test(msg)) {
        detail = `模型 "${model}" 在该 API 上不存在。\n请通过 CLAUDE_MODEL 或 VISION_MODEL 设置正确的模型名称。\n原始错误：${msg}`;
      } else if (/invalid api key|auth|unauthorized|forbidden/i.test(msg)) {
        detail = `API Key 鉴权失败，请检查 ANTHROPIC_API_KEY 是否正确。\n原始错误：${msg}`;
      } else {
        detail = msg;
      }
    } catch { /* ignore */ }
    console.error('[vision] HTTP', resp.status, detail.slice(0, 300));
    return new Error(`视觉 API HTTP ${resp.status}: ${detail}`);
  }

  console.log(`[vision] POST ${url} model=${model} format=${apiFormat} timeout=${timeoutMs}ms max_tokens=${VISION_MAX_TOKENS}`);

  // 不同协议接受的「关闭推理」参数不同：Anthropic 用 thinking，OpenAI 兼容网关
  // 常见 thinking / reasoning_effort 两种写法。按协议给，避免把不认识的参数发给官方端点。
  const noReasoning = apiFormat === 'anthropic'
    ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'disabled' }, reasoning_effort: 'none' };
  const forceNoReasoning = String(process.env.VISION_DISABLE_REASONING || '').toLowerCase() === 'true';

  let first = await postOnce(forceNoReasoning ? noReasoning : null);
  // 端点不认这些参数时会 4xx：退回普通请求，别因为一个优化参数把功能弄挂
  if (forceNoReasoning && !first.resp.ok && first.resp.status >= 400 && first.resp.status < 500) {
    console.warn(`[vision] 端点不接受关闭推理参数（HTTP ${first.resp.status}），退回普通请求`);
    first = await postOnce(null);
  }
  const { resp, body } = first;
  if (!resp.ok) throw httpError(resp, body);
  let out = extract(body);

  // 失败模式：推理模型把 max_tokens 全用在 reasoning 上，content 返回空串
  // （指纹：finish_reason=length、reasoning_content 很长、content 为空）。
  // 未显式配置 VISION_DISABLE_REASONING 时，这里自动关推理重试一次 ——
  // 实测 deepseek 系模型由此从「永远拿不到输出」变成秒级返回正确 JSON。
  const looksLikeReasoningStarved =
    !out.text && out.parsed && out.finishReason === 'length' && out.reasoningChars > 0;

  if (!out.text && looksLikeReasoningStarved && !forceNoReasoning) {
    console.warn('[vision] content 为空且推理占满额度，关闭 reasoning 重试…');
    try {
      const retry = await postOnce(noReasoning);
      if (retry.resp.ok) {
        const out2 = extract(retry.body);
        if (out2.text) out = out2;
      } else {
        console.error('[vision] 关闭 reasoning 重试被拒: HTTP', retry.resp.status, retry.body.slice(0, 200));
      }
    } catch (e) {
      console.error('[vision] 关闭 reasoning 重试失败:', e.message);
    }
  }

  const text = out.text;
  if (!text) {
    const hint = looksLikeReasoningStarved
      ? '\n诊断：模型的推理内容占满了 max_tokens，导致正文为空。已自动尝试关闭 reasoning 仍失败。' +
        '\n可调大 VISION_MAX_TOKENS（当前 ' + VISION_MAX_TOKENS + '）或更换视觉模型。'
      : '';
    throw new Error(`视觉模型没有返回文本内容（model=${model}, format=${apiFormat}）${hint}`);
  }

  console.log(`[vision] recognized ${text.length} chars in ${Date.now() - t0}ms via ${model}`);
  if (emit) emit('ui_event', { type: 'vision_subagent_done', length: text.length, elapsed_ms: Date.now() - t0 });
  return text;
}

// 兼容旧接口名
export function runVisionSubagent(imageDataUrl, emit) {
  return runVisionHttp(imageDataUrl, emit);
}
