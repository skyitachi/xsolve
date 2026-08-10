// 运行时配置管理 controller（三组独立 API 配置 + 通用 fallback）
import { getEffectiveSettings, applySettings, testConnection } from '../settings.js';
import { getChatApiConfig, getJudgeApiConfig, isOfficialAnthropic } from '../api-config.js';
import { getVisionApiConfig, resolveApiFormat } from '../vision.js';

// GET /api/settings — 当前有效配置（API Key 已脱敏）
export function getSettings(_req, res) {
  res.json(getEffectiveSettings());
}

// PUT /api/settings — 保存配置（空字段 = 回退 .env），立即生效
export function updateSettings(req, res) {
  const {
    commonApiKey, commonBaseUrl,
    chatApiKey, chatBaseUrl, chatModel,
    visionApiKey, visionBaseUrl, visionModel,
    judgeApiKey, judgeBaseUrl, judgeModel,
  } = req.body || {};

  // 基本校验：所有 Base URL 字段
  for (const [name, val] of [
    ['通用 Base URL', commonBaseUrl],
    ['主对话 Base URL', chatBaseUrl],
    ['视觉 Base URL', visionBaseUrl],
    ['Judge Base URL', judgeBaseUrl],
  ]) {
    if (val !== undefined && String(val).trim() !== '') {
      const raw = String(val).trim();
      if (!/^https?:\/\//i.test(raw)) {
        return res.status(400).json({ error: `${name} 需以 http:// 或 https:// 开头` });
      }
    }
  }

  const effective = applySettings({
    commonApiKey, commonBaseUrl,
    chatApiKey, chatBaseUrl, chatModel,
    visionApiKey, visionBaseUrl, visionModel,
    judgeApiKey, judgeBaseUrl, judgeModel,
  });
  res.json({ ok: true, message: '配置已保存', settings: effective });
}

// POST /api/settings/test — 用表单当前值测试连接（不保存）
// 留空时回退到当前生效的配置（已保存的 DB 值或 .env）
// body: { module: 'chat'|'vision'|'judge', apiKey?, baseUrl?, model? }
export async function testSettings(req, res) {
  const { module: mod = 'chat', apiKey, baseUrl, model } = req.body || {};

  let cfg, effectiveModel, format;

  if (mod === 'vision') {
    cfg = getVisionApiConfig();
    effectiveModel = process.env.VISION_MODEL || process.env.CLAUDE_MODEL || null;
    format = resolveApiFormat();
  } else if (mod === 'judge') {
    cfg = getJudgeApiConfig();
    effectiveModel = process.env.JUDGE_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
    format = resolveApiFormat();
    if (format === 'anthropic' && !isOfficialAnthropic(cfg.baseUrl)) format = 'openai';
  } else {
    // chat — 主对话代理固定 anthropic 格式
    cfg = getChatApiConfig();
    effectiveModel = process.env.CLAUDE_MODEL || (isOfficialAnthropic(cfg.baseUrl) ? 'claude-sonnet-4-20250514' : null);
    format = 'anthropic';
  }

  const test = {
    apiKey: (apiKey && String(apiKey).trim())
      ? String(apiKey).trim()
      : (cfg.apiKey || ''),
    baseUrl: (baseUrl && String(baseUrl).trim())
      ? String(baseUrl).trim()
      : (cfg.baseUrl || ''),
    model: (model && String(model).trim())
      ? String(model).trim()
      : (effectiveModel || ''),
    format,
  };

  if (!test.apiKey) {
    return res.json({ ok: false, message: 'API Key 为空：请填写要测试的 Key，或先保存配置' });
  }
  if (!test.model) {
    return res.json({ ok: false, message: '模型名为空：请填写模型名，或先保存配置' });
  }

  const result = await testConnection(test);
  res.json(result);
}
