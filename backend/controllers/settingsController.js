// 运行时配置管理 controller（API Key / Base URL / 模型名）
import { getEffectiveSettings, applySettings, testConnection } from '../settings.js';

// GET /api/settings — 当前有效配置（API Key 已脱敏）
export function getSettings(_req, res) {
  res.json(getEffectiveSettings());
}

// PUT /api/settings — 保存配置（空字段 = 回退 .env），立即生效
export function updateSettings(req, res) {
  const { apiKey, baseUrl, claudeModel, visionModel } = req.body || {};

  // 基本校验
  if (baseUrl !== undefined && String(baseUrl).trim() !== '') {
    const raw = String(baseUrl).trim();
    if (!/^https?:\/\//i.test(raw)) {
      return res.status(400).json({ error: 'API Base URL 需以 http:// 或 https:// 开头' });
    }
  }

  const effective = applySettings({ apiKey, baseUrl, claudeModel, visionModel });
  res.json({ ok: true, message: '配置已保存', settings: effective });
}

// POST /api/settings/test — 用表单当前值测试连接（不保存）
// API Key / Base URL / 模型 留空时回退到当前生效的配置（已保存的 DB 值或 .env）
export async function testSettings(req, res) {
  const { apiKey, baseUrl, model } = req.body || {};
  const effective = getEffectiveSettings();

  const test = {
    apiKey: (apiKey && String(apiKey).trim())
      ? String(apiKey).trim()
      : (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || ''),
    baseUrl: (baseUrl && String(baseUrl).trim())
      ? String(baseUrl).trim()
      : (process.env.ANTHROPIC_BASE_URL || ''),
    model: (model && String(model).trim())
      ? String(model).trim()
      : (process.env.CLAUDE_MODEL || ''),
  };
  if (!test.apiKey) {
    return res.json({ ok: false, message: 'API Key 为空：请填写要测试的 Key，或先保存配置' });
  }

  const result = await testConnection(test);
  res.json(result);
}
