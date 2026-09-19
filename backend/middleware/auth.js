// 鉴权中间件：统一 401 / 403 响应
// 用法：
//   app.get('/api/x', requireAuth, handler)            // 需登录
//   app.post('/api/y', requireAuth, requireAdmin, h)   // 需管理员
//   app.get('/api/z', requireAuth, requireRole('parent'), h)
import { getUserByToken, isBoundChild, insertAuditLog } from '../db.js';
import { tokenFromRequest } from '../auth.js';

function unauthorized(res, extra) {
  return res.status(401).json({ error: '请先登录', need_login: true, ...(extra || {}) });
}

function forbidden(res, msg = '无权访问') {
  return res.status(403).json({ error: msg });
}

/** 游客是否已过期（返回 true 时应视为未登录） */
function guestExpired(user) {
  if (!user || !user.guest_expires_at) return false;
  return user.guest_expires_at <= Math.floor(Date.now() / 1000);
}

/** 客户端信息（审计用） */
export function clientMeta(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null,
    user_agent: (req.headers['user-agent'] || '').slice(0, 255),
  };
}

/**
 * 写一条审计日志。失败绝不影响业务（best-effort）。
 * @param {object} req 请求（取 actor / ip / ua）
 * @param {string} action 动作名，如 'login_success' / 'password_change'
 * @param {object} opts { target_type, target_id, detail, actor }
 */
export function audit(req, action, opts = {}) {
  try {
    const actor = opts.actor || req.user || {};
    const meta = clientMeta(req);
    insertAuditLog({
      actor_id: actor.id || null,
      actor_username: actor.username || null,
      actor_role: actor.role || null,
      action,
      target_type: opts.target_type || null,
      target_id: opts.target_id || null,
      detail: opts.detail || null,
      ip: meta.ip,
      user_agent: meta.user_agent,
    });
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
}

/**
 * 解析登录态并挂到 req.user / req.authToken。
 * 未登录 → 401（前端据 need_login 跳登录页）。
 * 游客过期 → 401 + guest_expired（前端提示「试用已结束，请注册」）。
 */
export function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return unauthorized(res);
  let user = null;
  try {
    user = getUserByToken(token);
  } catch (e) {
    console.error('[auth] getUserByToken failed:', e.message);
    return unauthorized(res);
  }
  if (!user) return unauthorized(res);
  if (guestExpired(user)) return unauthorized(res, { guest_expired: true });
  req.user = user;
  req.authToken = token;
  next();
}

/**
 * 角色白名单。必须在 requireAuth 之后使用。
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);
    if (!roles.includes(req.user.role)) return forbidden(res, '当前角色无权访问');
    next();
  };
}

/**
 * 家庭管理员（可访问管理页：评估 / Prompt / 模型配置 / 账号管理）。
 */
export function requireAdmin(req, res, next) {
  if (!req.user) return unauthorized(res);
  if (!req.user.is_admin) return forbidden(res, '需要管理员权限');
  next();
}

/**
 * 要求当前用户是「该学生」的家长（已绑定）。
 * @param {(req) => string|null} pick 从请求中取学生 id（params / query / body）
 * 通过后挂 req.targetStudentId。
 */
export function requireParentOf(pick) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);
    const raw = pick(req);
    const wanted = (raw === undefined || raw === null || raw === '') ? null : String(raw);
    if (!wanted) return res.status(400).json({ error: '未指定学生' });
    if (req.user.is_admin || req.user.role === 'admin') { req.targetStudentId = wanted; return next(); }
    if (req.user.role !== 'parent') return forbidden(res, '仅家长可访问');
    if (!isBoundChild(req.user.id, wanted)) return forbidden(res, '仅可查看已绑定孩子的数据');
    req.targetStudentId = wanted;
    next();
  };
}

/**
 * 解析「本次请求要访问的学生 id」，并校验当前用户是否有权访问。
 * - student：只能是自己
 * - parent ：必须是已绑定的孩子
 * - admin  ：任意
 * 成功时挂到 req.targetStudentId；无权 → 403。
 *
 * @param {(req) => string|null} pick 从请求中取学生 id（query / body / params）
 */
export function resolveTargetStudent(pick) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);
    const raw = pick(req);
    const wanted = (raw === undefined || raw === null || raw === '') ? null : String(raw);

    if (req.user.role === 'student') {
      // 学生只能看自己：忽略传入值（防止越权探测）
      req.targetStudentId = req.user.id;
      return next();
    }
    if (req.user.role === 'parent') {
      if (!wanted) {
        // 未指定：回落到第一个绑定的孩子
        const children = req.user.children || [];
        if (!children.length) return forbidden(res, '尚未绑定孩子');
        req.targetStudentId = children[0].id;
        return next();
      }
      const isChild = (req.user.children || []).some((c) => c.id === wanted);
      if (!isChild) return forbidden(res, '仅可查看已绑定孩子的数据');
      req.targetStudentId = wanted;
      return next();
    }
    // admin
    req.targetStudentId = wanted;
    next();
  };
}

export { unauthorized, forbidden, guestExpired };
