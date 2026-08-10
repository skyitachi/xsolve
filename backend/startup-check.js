// 启动检查：探测各 AI 模块接入情况，不通过则打 error 日志
//
// 检查项：
//   1. DB / Prompt：DB 可用且 student/parent/judge 都有活跃 prompt 版本
//   2. 主对话代理（SDK/Anthropic API）— 使用 CLAUDE_API_KEY / CLAUDE_BASE_URL（fallback ANTHROPIC_*）
//   3. 视觉子代理（Vision）— 使用 VISION_API_KEY / VISION_BASE_URL（fallback ANTHROPIC_*）
//   4. LLM Judge（Eval）— 使用 JUDGE_API_KEY / JUDGE_BASE_URL（fallback CLAUDE_* → ANTHROPIC_*）
//
// 每项发一个最小 chat 请求（max_tokens 16, "ping"）验证：API 可达 + 鉴权 + 模型存在。
// 不阻断启动，只打日志。可用 SKIP_STARTUP_CHECK=1 跳过。
import './env.js'; // 确保单独调用时也加载了 .env
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVisionApiConfig, resolveApiFormat } from './vision.js';
import { getChatApiConfig, getJudgeApiConfig, isOfficialAnthropic } from './api-config.js';
import { getDb, getActivePromptVersion } from './db.js';

const TIMEOUT_MS = 20000;
function getJudgeModel() {
  return process.env.JUDGE_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
}

// Judge 的有效格式：anthropic 格式但第三方代理 → 降级为 openai（同 llm-judge.js 逻辑）
function resolveJudgeFormat(baseUrl) {
  let f = resolveApiFormat();
  if (f === 'anthropic' && !isOfficialAnthropic(baseUrl)) f = 'openai';
  return f;
}

// 视觉模型名解析（复刻 vision.js 内部 resolveVisionModel，未导出）
function resolveVisionModelSafe(format, baseUrl) {
  if (process.env.VISION_MODEL) return process.env.VISION_MODEL;
  if (format === 'anthropic') {
    if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
    if (isOfficialAnthropic(baseUrl)) return 'claude-sonnet-4-20250514';
    return null;
  }
  return null;
}

/**
 * 发一个最小 chat 请求探测接入
 * @returns {Promise<{label:string, ok:boolean, detail:string, elapsedMs:number}>}
 */
async function pingChat({ label, baseUrl, apiKey, model, format }) {
  if (!apiKey) return { label, ok: false, detail: '未配置 API Key', elapsedMs: 0 };
  if (!model) return { label, ok: false, detail: '未配置模型名（跳过探测）', elapsedMs: 0 };

  const t0 = Date.now();
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), TIMEOUT_MS);

  let url, headers, payload;
  if (format === 'anthropic') {
    url = `${baseUrl}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    payload = { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  } else {
    url = /\/v\d+\//.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    payload = { model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  }

  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
    const elapsedMs = Date.now() - t0;
    if (resp.ok) return { label, ok: true, detail: `${format} · ${model} · HTTP ${resp.status}`, elapsedMs };
    const text = await resp.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.message || JSON.stringify(j.error || j).slice(0, 300);
    } catch { /* keep raw */ }
    return { label, ok: false, detail: `HTTP ${resp.status} ${msg}`, elapsedMs };
  } catch (e) {
    return { label, ok: false, detail: `${ac.signal.aborted ? '超时' : '网络错误'}: ${e.message}`, elapsedMs: Date.now() - t0 };
  } finally {
    clearTimeout(to);
  }
}

function checkDb() {
  const t0 = Date.now();
  try {
    getDb();
    const roles = ['student', 'parent', 'judge'];
    const missing = roles.filter((r) => !getActivePromptVersion(r));
    if (missing.length) {
      return { label: 'DB / Prompt', ok: false, detail: `缺少活跃 prompt: ${missing.join(', ')}`, elapsedMs: Date.now() - t0 };
    }
    return { label: 'DB / Prompt', ok: true, detail: 'student/parent/judge 活跃版本就绪', elapsedMs: Date.now() - t0 };
  } catch (e) {
    return { label: 'DB / Prompt', ok: false, detail: e.message, elapsedMs: Date.now() - t0 };
  }
}

// 检测 ~/.claude/settings.json 的 ANTHROPIC_AUTH_TOKEN 是否与 .env 的 API Key 冲突
// SDK（Claude Code 子进程）会读 settings.json，若其中含 ANTHROPIC_AUTH_TOKEN 会优先用 Bearer 鉴权，
// 覆盖 .env 的 API Key，导致打到错误端点 401。session.js 已用 settingSources:['project'] 隔离。
function checkSettingsConflict() {
  const t0 = Date.now();
  const envApiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  let settingsAuthToken = null;
  let settingsBaseUrl = null;
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const env = s.env || {};
      settingsAuthToken = env.ANTHROPIC_AUTH_TOKEN || null;
      settingsBaseUrl = env.ANTHROPIC_BASE_URL || null;
    }
  } catch { /* ignore */ }

  if (settingsAuthToken && (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    return {
      label: 'settings.json 鉴权冲突',
      ok: true,
      detail: `settings.json 含 ANTHROPIC_AUTH_TOKEN（与 .env API Key 冲突，base=${settingsBaseUrl || '?'})；已由 session.js settingSources:['project'] 隔离，若仍 401 请检查此项`,
      elapsedMs: Date.now() - t0,
    };
  }
  if (settingsAuthToken && !process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return { label: 'settings.json 鉴权冲突', ok: true, detail: '使用 settings.json 的 ANTHROPIC_AUTH_TOKEN 鉴权', elapsedMs: Date.now() - t0 };
  }
  return { label: 'settings.json 鉴权冲突', ok: true, detail: '无冲突', elapsedMs: Date.now() - t0 };
}

/**
 * 执行全部启动检查并打印结果。不抛异常、不阻断启动。
 */
export async function runStartupChecks() {
  if (process.env.SKIP_STARTUP_CHECK === '1' || process.env.STARTUP_CHECK === '0') {
    console.log('[startup-check] 已跳过（SKIP_STARTUP_CHECK=1）');
    return;
  }

  console.log('[startup-check] 开始检测各模块接入情况...');
  const results = [];

  // 1. DB / Prompt
  results.push(checkDb());

  // 2. settings.json 鉴权冲突检测（SDK 是否会被全局 settings 劫持）
  results.push(checkSettingsConflict());

  // 3. 主对话代理（SDK 走 Anthropic 协议，固定 anthropic 格式探测）
  const chat = getChatApiConfig();
  const chatModel = process.env.CLAUDE_MODEL || (isOfficialAnthropic(chat.baseUrl) ? 'claude-sonnet-4-20250514' : null);
  results.push(await pingChat({
    label: '主对话代理 (SDK/Anthropic)',
    baseUrl: chat.baseUrl, apiKey: chat.apiKey, model: chatModel, format: 'anthropic',
  }));

  // 4. 视觉子代理（按其自身配置与格式）
  const vcfg = getVisionApiConfig();
  const vfmt = resolveApiFormat();
  const vmodel = resolveVisionModelSafe(vfmt, vcfg.baseUrl);
  results.push(await pingChat({
    label: '视觉子代理 (Vision)',
    baseUrl: vcfg.baseUrl, apiKey: vcfg.apiKey, model: vmodel, format: vfmt,
  }));

  // 5. LLM Judge（使用独立的 Judge API 配置 + JUDGE_MODEL）
  const jcfg = getJudgeApiConfig();
  const jfmt = resolveJudgeFormat(jcfg.baseUrl);
  results.push(await pingChat({
    label: 'LLM Judge (Eval)',
    baseUrl: jcfg.baseUrl, apiKey: jcfg.apiKey, model: getJudgeModel(), format: jfmt,
  }));

  // 汇总打印
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    const line = `[startup-check] ${r.ok ? '✅' : '❌'} ${r.label} — ${r.detail} (${r.elapsedMs}ms)`;
    if (r.ok) console.log(line);
    else console.error(line);
  }

  if (passed === results.length) {
    console.log(`[startup-check] ✅ 全部 ${results.length} 项检查通过`);
  } else {
    console.error(`[startup-check] ❌ ${results.length - passed}/${results.length} 项未通过，请检查上方 error 日志`);
  }
}
