// 账号管理 controller（用户系统 P2）—— 管理页 accounts.html 的数据源。
// 全部路由已由 requireAuth + requireAdmin 保护（见 app.js）。
// 安全护栏：
//   - 不能停用 / 删除自己
//   - 不能移除最后一个活跃管理员
//   - 不能删除最后一个管理员账号
import {
  listUsersWithStats,
  getUserById,
  getUserByUsername,
  countAdmins,
  countUsers,
  updateUserPassword,
  setUserStatus,
  setUserAdmin,
  setUserDisplayName,
  deleteUser,
  deleteUserSessionsOfUser,
  listAuditLogs,
  listChildren,
  getChildStats,
  purgeExpiredGuests,
  createUser,
  linkParentChild,
} from '../db.js';
import { hashPassword } from '../auth.js';
import { audit } from '../middleware/auth.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const MIN_PASSWORD = 6;

function fail(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

function pickId(req) {
  return req.params.id || req.params.userId;
}

// GET /api/admin/users —— 账号列表（含运营统计）
export function adminListUsers(req, res) {
  try {
    const role = req.query.role || null;
    const rows = listUsersWithStats();
    res.json({
      users: role ? rows.filter((u) => u.role === role) : rows,
      totals: {
        all: countUsers(),
        admins: countAdmins(),
        students: countUsers('student'),
        parents: countUsers('parent'),
        guests: rows.filter((u) => u.is_guest).length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/admin/users/:id —— 单个账号详情（含孩子 / 统计）
export function adminGetUser(req, res) {
  try {
    const id = pickId(req);
    const user = getUserById(id);
    if (!user) return fail(res, '账号不存在', 404);
    let children = [];
    let stats = null;
    try {
      if (user.role === 'parent') children = listChildren(id);
      else stats = getChildStats(id);
    } catch { /* ignore */ }
    res.json({ user, children, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/admin/users/:id/password —— 重置密码（忘记密码场景）
export function adminResetPassword(req, res) {
  try {
    const id = pickId(req);
    const user = getUserById(id);
    if (!user) return fail(res, '账号不存在', 404);
    const body = req.body || {};
    const pw = String(body.password || '').trim();
    if (pw && pw.length < MIN_PASSWORD) return fail(res, `密码至少 ${MIN_PASSWORD} 位`);

    if (!pw && !body.force_random) return fail(res, '请提供新密码');
    // 未提供密码时可生成一个随机初始密码（便于口头转达）
    const newPassword = pw || ('xs' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10));

    updateUserPassword(id, hashPassword(newPassword));
    // 踢掉该账号所有登录态，旧 Cookie 立即失效
    deleteUserSessionsOfUser(id);
    audit(req, 'password_reset', { target_type: 'user', target_id: id, detail: `by=${req.user.username}` });

    res.json({ ok: true, generated: !pw, password: pw ? undefined : newPassword });
  } catch (e) {
    res.status(500).json({ error: e.message || '重置密码失败' });
  }
}

// POST /api/admin/users/:id/status —— 启用 / 停用
export function adminSetStatus(req, res) {
  try {
    const id = pickId(req);
    const user = getUserById(id);
    if (!user) return fail(res, '账号不存在', 404);
    const status = String((req.body || {}).status || '');
    if (!['active', 'disabled'].includes(status)) return fail(res, 'status 只能是 active / disabled');
    if (id === req.user.id && status === 'disabled') return fail(res, '不能停用自己的账号', 400);
    if (status === 'disabled' && user.is_admin && countAdmins() <= 1) {
      return fail(res, '至少保留一个可用管理员', 400);
    }

    setUserStatus(id, status);
    if (status === 'disabled') deleteUserSessionsOfUser(id);
    audit(req, status === 'disabled' ? 'account_disable' : 'account_enable', { target_type: 'user', target_id: id });
    res.json({ ok: true, user: getUserById(id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/admin/users/:id/admin —— 授予 / 取消管理员
export function adminSetAdmin(req, res) {
  try {
    const id = pickId(req);
    const user = getUserById(id);
    if (!user) return fail(res, '账号不存在', 404);
    const isAdmin = !!(req.body || {}).is_admin;
    if (id === req.user.id && !isAdmin) return fail(res, '不能撤销自己的管理员权限', 400);
    if (!isAdmin && user.is_admin && countAdmins() <= 1) {
      return fail(res, '至少保留一个管理员', 400);
    }
    setUserAdmin(id, isAdmin);
    audit(req, isAdmin ? 'admin_grant' : 'admin_revoke', { target_type: 'user', target_id: id });
    res.json({ ok: true, user: getUserById(id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// PATCH /api/admin/users/:id —— 改昵称
export function adminPatchUser(req, res) {
  try {
    const id = pickId(req);
    const user = getUserById(id);
    if (!user) return fail(res, '账号不存在', 404);
    const body = req.body || {};
    if (body.display_name !== undefined) {
      setUserDisplayName(id, String(body.display_name || '').trim().slice(0, 40) || null);
      audit(req, 'account_rename', { target_type: 'user', target_id: id, detail: body.display_name });
    }
    res.json({ ok: true, user: getUserById(id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// DELETE /api/admin/users/:id —— 删除账号（连带其会话与记忆数据）
export function adminDeleteUser(req, res) {
  try {
    const id = pickId(req);
    const user = getUserById(id);
    if (!user) return fail(res, '账号不存在', 404);
    if (id === req.user.id) return fail(res, '不能删除自己的账号', 400);
    if (user.is_admin && countAdmins() <= 1) return fail(res, '至少保留一个管理员', 400);

    const detail = `${user.username}/${user.role}${user.is_guest ? '/guest' : ''}`;
    deleteUser(id);
    audit(req, 'account_delete', { target_type: 'user', target_id: id, detail });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '删除失败' });
  }
}

// GET /api/admin/audit?limit=100&action=login_success
export function adminAuditLogs(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const action = req.query.action || null;
    const actorId = req.query.actor_id || null;
    res.json({ logs: listAuditLogs({ limit, action, actor_id: actorId }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/admin/guests/purge —— 手动清理到期游客
export function adminPurgeGuests(req, res) {
  try {
    const r = purgeExpiredGuests();
    if (r.removed) audit(req, 'guest_purge', { detail: `removed=${r.removed}` });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * POST /api/admin/users —— 管理员直接创建账号（家长代建孩子账号等场景）。
 * 孩子账号由家长创建时可不带邀请码，直接建立绑定关系。
 */
export function adminCreateUser(req, res) {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'parent' ? 'parent' : 'student';
    const displayName = String(body.display_name || '').trim().slice(0, 40) || null;

    if (!USERNAME_RE.test(username)) return fail(res, '用户名需为 3-32 位字母、数字或下划线');
    if (password.length < MIN_PASSWORD) return fail(res, `密码至少 ${MIN_PASSWORD} 位`);
    if (getUserByUsername(username)) return fail(res, '该用户名已被占用', 409);

    const created = createUser({
      role,
      username,
      display_name: displayName,
      password_hash: hashPassword(password),
      is_admin: body.is_admin ? 1 : 0,
    });
    if (role === 'student' && body.parent_id) {
      linkParentChild(String(body.parent_id), created.id, body.relation || null);
    }
    audit(req, 'account_create', { target_type: 'user', target_id: created.id, detail: `${username}/${role}` });
    res.status(201).json({ ok: true, user: getUserById(created.id) });
  } catch (e) {
    res.status(500).json({ error: e.message || '创建账号失败' });
  }
}
