// Langfuse 配置
// 未配置密钥时自动降级为 no-op，不影响主流程

export const LANGFUSE_ENABLED = process.env.LANGFUSE_ENABLED === 'true';
export const LANGFUSE_HOST = (process.env.LANGFUSE_HOST || 'http://localhost:3000').replace(/\/$/, '');
export const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || '';
export const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || '';
export const LANGFUSE_SAMPLE_RATE = parseFloat(process.env.LANGFUSE_SAMPLE_RATE || '1.0');

// 是否真正可用（启用 + 有密钥）
export const LANGFUSE_ACTIVE = LANGFUSE_ENABLED && LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY;

// Basic Auth header
export function getAuthHeader() {
  if (!LANGFUSE_ACTIVE) return null;
  const credentials = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');
  return `Basic ${credentials}`;
}

// 采样判断
export function shouldSample() {
  if (!LANGFUSE_ACTIVE) return false;
  if (LANGFUSE_SAMPLE_RATE >= 1.0) return true;
  return Math.random() < LANGFUSE_SAMPLE_RATE;
}
