// 运行时配置管理：让 API Key / Base URL / 模型名可以在管理页里改，无需改 .env 重启
//
// 优先级模型：
//   - 数据库 settings 表中保存的值 > .env / 环境变量
//   - 管理页留空保存 = 删除该行，回退使用 .env 的值
//   - initSettings() 在启动时把 DB 值覆盖到 process.env，保证各模块惰性读取到 DB 配置
import {
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
  getDb,
} from './db.js';

// 管理页可配置的键
export const MANAGED_KEYS = {
  ANTHROPIC_API_KEY:   { label: 'API Key',        secret: true  },
  ANTHROPIC_BASE_URL:  { label: 'API Base URL',   secret: false },
  CLAUDE_MODEL:        { label: '对话模型',       secret: false },
  VISION_MODEL:        { label: '视觉模型',       secret: false },
};

// 启动时 .env / 环境变量的原始值快照：清空 DB 设置时用于立即回退
const ORIGINAL_ENV = {};

/**
 * 启动时调用：把 DB 里保存的设置覆盖到 process.env
 * 之后所有惰性读取（process.env.XXX / getClaudeModel() 等）都会拿到 DB 配置
 */
export function initSettings() {
  getDb(); // 确保 schema（settings 表）就绪
  // 先快照原始环境变量（.env / compose 注入），再叠加 DB 覆盖
  for (const key of Object.keys(MANAGED_KEYS)) {
    ORIGINAL_ENV[key] = process.env[key];
  }
  for (const row of getAllSettings()) {
    if (row.value) process.env[row.key] = row.value;
  }
}

/**
 * 读取当前有效配置（DB 优先，其次 .env / 环境变量）
 * 返回管理页友好结构，API Key 脱敏
 */
export function getEffectiveSettings() {
  const rows = getAllSettings();
  const map = new Map(rows.map(r => [r.key, r.value]));

  const pick = (key) => {
    const dbVal = map.has(key) ? map.get(key) : null;
    const envVal = process.env[key] || '';
    const fromDb = !!dbVal; // 空串视为未配置，回退 .env
    const value = fromDb ? dbVal : envVal;
    return { value, fromDb };
  };

  const apiKeyInfo = pick('ANTHROPIC_API_KEY');
  const baseUrlInfo = pick('ANTHROPIC_BASE_URL');
  const claudeModelInfo = pick('CLAUDE_MODEL');
  const visionModelInfo = pick('VISION_MODEL');

  return {
    apiKey: maskKey(apiKeyInfo.value),
    apiKeyMasked: maskKey(apiKeyInfo.value),
    apiKeySet: !!apiKeyInfo.value,
    apiKeySource: apiKeyInfo.fromDb ? 'db' : 'env',
    baseUrl: baseUrlInfo.value,
    baseUrlSource: baseUrlInfo.fromDb ? 'db' : 'env',
    claudeModel: claudeModelInfo.value,
    claudeModelSource: claudeModelInfo.fromDb ? 'db' : 'env',
    visionModel: visionModelInfo.value,
    visionModelSource: visionModelInfo.fromDb ? 'db' : 'env',
  };
}

/**
 * 保存配置（部分字段允许）：空字符串 = 删除该行回退 .env
 * 立即更新 process.env，新会话 / 视觉调用即刻生效
 */
export function applySettings(patch = {}) {
  const updates = {
    ANTHROPIC_API_KEY: patch.apiKey,
    ANTHROPIC_BASE_URL: patch.baseUrl,
    CLAUDE_MODEL: patch.claudeModel,
    VISION_MODEL: patch.visionModel,
  };

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined) continue; // 未提交该字段，不动
    const v = String(val).trim();
    if (v === '') {
      deleteSetting(key); // 回退 .env：立即恢复原始环境变量值
      const orig = ORIGINAL_ENV[key];
      if (orig !== undefined) process.env[key] = orig;
      else delete process.env[key];
    } else {
      upsertSetting(key, v);
      process.env[key] = v; // 立即生效
    }
  }

  return getEffectiveSettings();
}

/**
 * 测试连接：向 {baseUrl}/v1/messages 发一个最小请求，验证 Key + BaseURL + 模型
 * @param {object} cfg - { apiKey, baseUrl, model }
 */
export async function testConnection({ apiKey, baseUrl, model } = {}) {
  if (!apiKey) return { ok: false, message: '请先填写 API Key' };
  if (!baseUrl) return { ok: false, message: '请先填写 API Base URL' };
  if (!model) return { ok: false, message: '请先填写要测试的模型名' };

  const cleanUrl = String(baseUrl).trim().replace(/\/+$/, '');
  const url = `${cleanUrl}/v1/messages`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': String(apiKey).trim(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: String(model).trim(),
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
  } catch (e) {
    return { ok: false, message: `网络请求失败: ${e.message}\n地址: ${url}` };
  }

  const body = await resp.text();
  if (resp.ok) {
    return { ok: true, message: `连接成功！${url} 可用模型 ${model}` };
  }

  let detail = body.slice(0, 800);
  try {
    const j = JSON.parse(body);
    detail = j.error?.message || j.message || JSON.stringify(j.error || j);
  } catch { /* keep raw */ }

  if (/invalid api key|auth|unauthorized|forbidden|401/i.test(detail)) {
    return { ok: false, message: `API Key 鉴权失败（HTTP ${resp.status}）\n${detail}` };
  }
  if (/model.*not found|invalid model|unknown model|404/i.test(detail)) {
    return { ok: false, message: `模型 "${model}" 在该 API 上不存在（HTTP ${resp.status}）\n${detail}` };
  }
  return { ok: false, message: `HTTP ${resp.status}: ${detail}` };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// 供其它模块复用
export { getSetting, upsertSetting, deleteSetting };
