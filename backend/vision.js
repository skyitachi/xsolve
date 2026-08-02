// 视觉识别子代理：调用视觉模型识别图片（题目OCR + 草稿手写识别）
// 支持 Anthropic Messages API 格式和 OpenAI Chat Completions 格式
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VISION_SUBAGENT_PROMPT } from './config.js';

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

/**
 * 判断应该使用哪种 API 格式
 * - 默认使用 Anthropic 格式（因为主 SDK 只支持 Anthropic 格式，代理必须兼容此格式）
 * - 设置 VISION_API_FORMAT=openai 可强制使用 OpenAI 格式
 * - 视觉单独配置了 VISION_BASE_URL 时，无法从 URL 推断协议，默认 anthropic
 *   （需要 OpenAI 格式时必须显式设置 VISION_API_FORMAT=openai）
 * - 未单独配置视觉地址时：只设了 OPENAI_BASE_URL 而没设 ANTHROPIC_BASE_URL，使用 OpenAI 格式
 */
export function resolveApiFormat() {
  const explicit = process.env.VISION_API_FORMAT;
  if (explicit === 'openai') return 'openai';
  if (explicit === 'anthropic') return 'anthropic';
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
export async function runVisionHttp(imageDataUrl, emit, customPrompt) {
  const m = String(imageDataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('invalid image data url');
  const mediaType = m[1], base64Data = m[2];

  const { baseUrl, apiKey } = getVisionApiConfig();
  if (!apiKey) throw new Error('未找到 API Key。请设置 VISION_API_KEY 或 ANTHROPIC_API_KEY 环境变量。');

  const apiFormat = resolveApiFormat();
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
  let resp, body;
  try {
    let url, payload, headers;
    if (apiFormat === 'anthropic') {
      url = `${baseUrl}/v1/messages`;
      headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
      payload = {
        model,
        max_tokens: 2048,
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
      payload = {
        model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: promptText }
          ]
        }]
      };
    }
    console.log(`[vision] POST ${url} model=${model} format=${apiFormat}`);
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    console.error('[vision] network error', e.message);
    throw new Error(`视觉 API 网络错误: ${e.message}\n地址: ${baseUrl}, 模型: ${model}`);
  }

  body = await resp.text();
  if (!resp.ok) {
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
    throw new Error(`视觉 API HTTP ${resp.status}: ${detail}`);
  }

  let text = '';
  try {
    const j = JSON.parse(body);
    if (apiFormat === 'anthropic') {
      for (const block of (j.content || [])) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    } else {
      const content = j.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      } else {
        text = content || '';
      }
    }
  } catch {
    text = body;
  }

  text = (text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if (!text) {
    throw new Error(`视觉模型没有返回文本内容（model=${model}, format=${apiFormat}）`);
  }

  console.log(`[vision] recognized ${text.length} chars in ${Date.now() - t0}ms via ${model}`);
  if (emit) emit('ui_event', { type: 'vision_subagent_done', length: text.length, elapsed_ms: Date.now() - t0 });
  return text;
}

// 兼容旧接口名
export function runVisionSubagent(imageDataUrl, emit) {
  return runVisionHttp(imageDataUrl, emit);
}
