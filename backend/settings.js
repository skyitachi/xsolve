// 运行时配置管理：让 API Key / Base URL / 模型名可以在管理页里改，无需改 .env 重启
//
// 优先级模型：
//   - 数据库 settings 表中保存的值 > .env / 环境变量
//   - 管理页留空保存 = 删除该行，回退使用 .env 的值
//   - initSettings() 在启动时把 DB 值覆盖到 process.env，保证各模块惰性读取到 DB 配置
//
// 支持三组独立 API 配置 + 通用 fallback：
//   通用:       ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
//   主对话模型:  CLAUDE_API_KEY / CLAUDE_BASE_URL / CLAUDE_MODEL  → fallback 通用
//   视觉模型:    VISION_API_KEY / VISION_BASE_URL / VISION_MODEL   → fallback 通用
//   Judge 模型:  JUDGE_API_KEY / JUDGE_BASE_URL / JUDGE_MODEL      → fallback 主对话 → 通用
import {
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
  getDb,
} from './db.js';

// 管理页可配置的键
export const MANAGED_KEYS = {
  // 通用 fallback
  ANTHROPIC_API_KEY:   { label: '通用 API Key',       secret: true,  group: 'common' },
  ANTHROPIC_BASE_URL:  { label: '通用 API Base URL',  secret: false, group: 'common' },
  // 主对话模型
  CLAUDE_API_KEY:      { label: '主对话 API Key',     secret: true,  group: 'chat'   },
  CLAUDE_BASE_URL:     { label: '主对话 Base URL',    secret: false, group: 'chat'   },
  CLAUDE_MODEL:        { label: '对话模型',           secret: false, group: 'chat'   },
  // 视觉模型
  VISION_API_KEY:      { label: '视觉 API Key',       secret: true,  group: 'vision' },
  VISION_BASE_URL:     { label: '视觉 Base URL',      secret: false, group: 'vision' },
  VISION_MODEL:        { label: '视觉模型',           secret: false, group: 'vision' },
  // Judge 评估模型
  JUDGE_API_KEY:       { label: 'Judge API Key',      secret: true,  group: 'judge'  },
  JUDGE_BASE_URL:      { label: 'Judge Base URL',     secret: false, group: 'judge'  },
  JUDGE_MODEL:         { label: 'Judge 模型',         secret: false, group: 'judge'  },
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
 * 读取单个键的当前有效配置（DB 优先，其次 .env / 环境变量）
 * @returns {{ value: string, set: boolean, source: 'db'|'env' }}
 */
function pickSetting(map, key) {
  const dbVal = map.has(key) ? map.get(key) : null;
  const envVal = ORIGINAL_ENV[key] || '';
  const fromDb = !!dbVal; // 空串视为未配置，回退 .env
  const value = fromDb ? dbVal : envVal;
  return { value, set: !!value, source: fromDb ? 'db' : 'env' };
}

/**
 * 读取当前有效配置（DB 优先，其次 .env / 环境变量）
 * 返回管理页友好结构，API Key 脱敏
 */
export function getEffectiveSettings() {
  const rows = getAllSettings();
  const map = new Map(rows.map(r => [r.key, r.value]));

  const pickMasked = (key) => {
    const info = pickSetting(map, key);
    return { value: maskKey(info.value), set: info.set, source: info.source };
  };

  const pickPlain = (key) => {
    const info = pickSetting(map, key);
    return { value: info.value, set: info.set, source: info.source };
  };

  return {
    common: {
      apiKey: pickMasked('ANTHROPIC_API_KEY'),
      baseUrl: pickPlain('ANTHROPIC_BASE_URL'),
    },
    chat: {
      apiKey: pickMasked('CLAUDE_API_KEY'),
      baseUrl: pickPlain('CLAUDE_BASE_URL'),
      model: pickPlain('CLAUDE_MODEL'),
    },
    vision: {
      apiKey: pickMasked('VISION_API_KEY'),
      baseUrl: pickPlain('VISION_BASE_URL'),
      model: pickPlain('VISION_MODEL'),
    },
    judge: {
      apiKey: pickMasked('JUDGE_API_KEY'),
      baseUrl: pickPlain('JUDGE_BASE_URL'),
      model: pickPlain('JUDGE_MODEL'),
    },
  };
}

/**
 * 保存配置（部分字段允许）：空字符串 = 删除该行回退 .env
 * 立即更新 process.env，新会话 / 视觉调用即刻生效
 *
 * @param {object} patch - 各组配置字段，undefined = 不修改，'' = 清空回退
 */
export function applySettings(patch = {}) {
  const updates = {
    ANTHROPIC_API_KEY:  patch.commonApiKey,
    ANTHROPIC_BASE_URL: patch.commonBaseUrl,
    CLAUDE_API_KEY:     patch.chatApiKey,
    CLAUDE_BASE_URL:    patch.chatBaseUrl,
    CLAUDE_MODEL:       patch.chatModel,
    VISION_API_KEY:     patch.visionApiKey,
    VISION_BASE_URL:    patch.visionBaseUrl,
    VISION_MODEL:       patch.visionModel,
    JUDGE_API_KEY:      patch.judgeApiKey,
    JUDGE_BASE_URL:     patch.judgeBaseUrl,
    JUDGE_MODEL:        patch.judgeModel,
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
 * 测试连接：向指定 API 发一个最小请求，验证 Key + BaseURL + 模型
 * @param {object} cfg - { apiKey, baseUrl, model, format }
 * @param {string} cfg.format - 'anthropic' | 'openai'，默认 'anthropic'
 */
export async function testConnection({ apiKey, baseUrl, model, format = 'anthropic' } = {}) {
  if (!apiKey) return { ok: false, message: '请先填写 API Key' };
  if (!baseUrl) return { ok: false, message: '请先填写 API Base URL' };
  if (!model) return { ok: false, message: '请先填写要测试的模型名' };

  const cleanUrl = String(baseUrl).trim().replace(/\/+$/, '');

  let url, headers, payload;
  if (format === 'openai') {
    url = /\/v\d+\//.test(cleanUrl) ? `${cleanUrl}/chat/completions` : `${cleanUrl}/v1/chat/completions`;
    headers = {
      'content-type': 'application/json',
      'authorization': `Bearer ${String(apiKey).trim()}`,
    };
    payload = {
      model: String(model).trim(),
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    };
  } else {
    // anthropic format
    url = `${cleanUrl}/v1/messages`;
    headers = {
      'content-type': 'application/json',
      'x-api-key': String(apiKey).trim(),
      'anthropic-version': '2023-06-01',
    };
    payload = {
      model: String(model).trim(),
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    };
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, message: `网络请求失败: ${e.message}\n地址: ${url}` };
  }

  const body = await resp.text();
  if (resp.ok) {
    return { ok: true, message: `连接成功！${url}\n模型 ${model}（${format} 格式）` };
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
