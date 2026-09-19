// 认证基础能力：密码哈希 / 令牌 / Cookie 读写
// 设计原则：零新增原生依赖——只用 Node 内置 crypto。
//   - 密码：scrypt + 随机盐，timingSafeEqual 常量时间比较
//   - 令牌：randomBytes(32).hex，明文存 user_sessions.token（服务端会话）
//   - 传输：httpOnly Cookie，前端 JS 读不到，规避 XSS 窃取
import crypto from 'node:crypto';
import { AUTH_COOKIE_NAME, SESSION_TTL_DAYS, AUTH_COOKIE_SECURE } from './config.js';

// scrypt 参数：N=16384（默认）在家庭场景下强度足够，单次 ~50ms
const SCRYPT_KEYLEN = 64;
const HASH_PREFIX = 'scrypt';

/**
 * 生成密码哈希，格式：scrypt$<salt-hex>$<hash-hex>
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `${HASH_PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * 校验密码。任何异常（格式错、空值）一律返回 false，不抛错。
 */
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** 生成登录令牌（64 位十六进制） */
export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** 生成邀请码（8 位大写字母数字，去掉易混淆字符） */
export function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 登录态过期时间戳（秒） */
export function sessionExpiry(ttlDays = SESSION_TTL_DAYS) {
  return Math.floor(Date.now() / 1000) + Math.max(1, ttlDays) * 86400;
}

/** 解析 Cookie 请求头 → 普通对象 */
export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    let v = part.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** 从请求中取登录令牌 */
export function tokenFromRequest(req) {
  return parseCookies(req.headers?.cookie)[AUTH_COOKIE_NAME] || null;
}

/** 下发登录 Cookie（httpOnly + SameSite=Lax） */
export function setAuthCookie(res, token, ttlDays = SESSION_TTL_DAYS) {
  const maxAge = Math.max(1, ttlDays) * 86400;
  const attrs = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (AUTH_COOKIE_SECURE) attrs.push('Secure');
  appendSetCookie(res, attrs.join('; '));
}

/** 清除登录 Cookie */
export function clearAuthCookie(res) {
  const attrs = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (AUTH_COOKIE_SECURE) attrs.push('Secure');
  appendSetCookie(res, attrs.join('; '));
}

// 支持一次响应下发多个 Set-Cookie（不依赖 express 的 res.cookie）
function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [cookie]);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookie]);
  else res.setHeader('Set-Cookie', [prev, cookie]);
}
