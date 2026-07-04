// 视觉识别子代理：直接 HTTP 调用视觉模型（OpenAI / Anthropic 兼容接口）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VISION_MODEL, VISION_SUBAGENT_PROMPT } from './config.js';

// API 配置读取（环境变量 + ~/.claude/settings.json）
function getVisionApiConfig() {
  let baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL;
  let apiKey = process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.OPENAI_API_KEY;

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
  if (!apiKey) throw new Error('未找到 API Key。请设置 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 环境变量，或通过 claude login 登录。');

  const isAnthropic = /anthropic\.com$/i.test(new URL(baseUrl).hostname);
  const model = VISION_MODEL;
  const visionPrompt = (customPrompt || VISION_SUBAGENT_PROMPT) + '\n\n请识别图片，按上述指定格式直接输出结果，绝对不要输出任何思考过程、不要用<thinking>标签。';

  if (emit) emit('ui_event', { type: 'vision_subagent_started', model });

  const t0 = Date.now();
  let resp, body;
  try {
    let url, payload, headers;
    if (isAnthropic) {
      url = `${baseUrl}/v1/messages`;
      headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
      payload = {
        model,
        max_tokens: 2048,
        system: customPrompt || VISION_SUBAGENT_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: customPrompt ? '请识别图片中的手写内容，按指定的JSON格式直接输出结果。' : '请识别这张小学数学题图片，按指定格式输出。' }
          ]
        }]
      };
    } else {
      url = `${baseUrl}/chat/completions`.replace(/\/+/g, '/').replace(':/', '://');
      if (!/\/v\d+\//.test(url) && !url.includes('/chat/completions')) {
        url = `${baseUrl}/v1/chat/completions`.replace(/\/+/g, '/').replace(':/', '://');
      }
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
            { type: 'text', text: visionPrompt }
          ]
        }]
      };
    }
    console.log(`[vision] POST ${url} model=${model}`);
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    console.error('[vision] network error', e.message);
    throw new Error(`视觉 API 网络错误: ${e.message}\n请求地址: ${baseUrl}, 模型: ${model}`);
  }

  body = await resp.text();
  if (!resp.ok) {
    let detail = body.slice(0, 1000);
    try {
      const j = JSON.parse(body);
      const msg = j.error?.message || j.message || JSON.stringify(j.error || j);
      if (/not a VLM|not.*vision|VLM|not support.*image/i.test(msg)) {
        detail = `模型 "${model}" 在该 API 上不支持图片识别。\n`
          + `你当前使用的 API 地址是: ${baseUrl}\n`
          + `请确认该平台上有可用的视觉模型，并通过环境变量指定，例如：\n`
          + `  VISION_MODEL=Pro/Qwen/Qwen2.5-VL-7B-Instruct node server.js\n`
          + `SiliconFlow 可用的视觉模型通常以 VL/VLM 结尾，可在控制台模型列表查看。\n`
          + `原始错误：${msg}`;
      } else {
        detail = msg;
      }
    } catch { /* ignore */ }
    console.error('[vision] HTTP error', resp.status, detail.slice(0, 300));
    throw new Error(`视觉 API HTTP ${resp.status}: ${detail}`);
  }

  let text = '';
  try {
    const j = JSON.parse(body);
    if (isAnthropic) {
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
    throw new Error(`视觉模型没有返回文本内容（model=${model}, baseUrl=${baseUrl}）`);
  }

  console.log(`[vision] recognized ${text.length} chars in ${Date.now() - t0}ms via ${model}`);
  if (emit) emit('ui_event', { type: 'vision_subagent_done', length: text.length, elapsed_ms: Date.now() - t0 });
  return text;
}

// 兼容旧接口名
export function runVisionSubagent(imageDataUrl, emit) {
  return runVisionHttp(imageDataUrl, emit);
}
