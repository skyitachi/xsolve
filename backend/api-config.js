// 共享 API 配置模块
// 统一管理主对话模型 (CLAUDE_MODEL) 和视觉模型 (VISION_MODEL) 的 API 配置
//
// 环境变量优先级（高 → 低）：
//   主对话模型: CLAUDE_API_KEY / CLAUDE_BASE_URL → ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL → settings.json
//   视觉模型:   VISION_API_KEY / VISION_BASE_URL → ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL → settings.json
//   Judge 模型: JUDGE_API_KEY / JUDGE_BASE_URL   → CLAUDE_API_KEY / CLAUDE_BASE_URL → ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL → settings.json
//
// 这样 CLAUDE_MODEL 和 VISION_MODEL 可以使用完全不同的 API 提供商
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 读取 ~/.claude/settings.json 中的 env 配置（作为 fallback）
 */
function readSettingsEnv() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return s.env || {};
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * 主对话模型 (CLAUDE_MODEL) 的 API 配置
 * 优先使用 CLAUDE_API_KEY / CLAUDE_BASE_URL，不存在时 fallback 到 ANTHROPIC_* 系列
 * @returns {{ baseUrl: string, apiKey: string|null }}
 */
export function getChatApiConfig() {
  const settingsEnv = readSettingsEnv();

  let baseUrl = process.env.CLAUDE_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || settingsEnv.ANTHROPIC_BASE_URL;
  let apiKey = process.env.CLAUDE_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settingsEnv.ANTHROPIC_API_KEY
    || settingsEnv.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl) baseUrl = 'https://api.anthropic.com';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: apiKey || null };
}

/**
 * Judge / Eval 模型的 API 配置
 * 优先使用 JUDGE_API_KEY / JUDGE_BASE_URL，不存在时 fallback 到主对话模型配置
 * @returns {{ baseUrl: string, apiKey: string|null }}
 */
export function getJudgeApiConfig() {
  const settingsEnv = readSettingsEnv();

  const chatConfig = getChatApiConfig();

  let baseUrl = process.env.JUDGE_BASE_URL
    || process.env.CLAUDE_BASE_URL
    || process.env.ANTHROPIC_BASE_URL
    || settingsEnv.ANTHROPIC_BASE_URL;
  let apiKey = process.env.JUDGE_API_KEY
    || process.env.CLAUDE_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || settingsEnv.ANTHROPIC_API_KEY
    || settingsEnv.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl) baseUrl = 'https://api.anthropic.com';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: apiKey || null };
}

/**
 * 判断 URL 是否为 Anthropic 官方 API
 */
export function isOfficialAnthropic(baseUrl) {
  try {
    const host = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl).hostname;
    return /anthropic\.com$/i.test(host);
  } catch { return false; }
}

/**
 * 构建 SDK 子进程环境变量
 * 将 CLAUDE_API_KEY / CLAUDE_BASE_URL 映射为 SDK 能识别的 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 * 同时移除 ANTHROPIC_AUTH_TOKEN 避免鉴权冲突
 */
export function buildSdkEnv() {
  const e = { ...process.env };
  delete e.ANTHROPIC_AUTH_TOKEN;

  // 如果设置了 CLAUDE_API_KEY，映射为 SDK 需要的 ANTHROPIC_API_KEY
  if (process.env.CLAUDE_API_KEY) {
    e.ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY;
  }
  // 如果设置了 CLAUDE_BASE_URL，映射为 SDK 需要的 ANTHROPIC_BASE_URL
  if (process.env.CLAUDE_BASE_URL) {
    e.ANTHROPIC_BASE_URL = process.env.CLAUDE_BASE_URL;
  }

  e.CLAUDE_AGENT_SDK_CLIENT_APP = 'selflearning/0.1.0';
  return e;
}
