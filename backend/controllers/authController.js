// 认证 controller：注册 / 登录 / 登出 / 当前用户 / 邀请码 / 孩子列表
// + P2：修改密码 / 游客试用 / 登录限流 / 审计
import {
  createUser,
  getUserById,
  getUserByUsername,
  getUserRowByUsername,
  touchUserLogin,
  insertUserSession,
  deleteUserSession,
  deleteUserSessionsOfUser,
  listChildren,
  listInviteCodes,
  getInviteCode,
  createInviteCode,
  redeemInviteCode,
  linkParentChild,
  updateUserPassword,
  recordLoginAttempt,
  countRecentFailedAttempts,
  nextGuestUsername,
} from '../db.js';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  generateInviteCode,
  sessionExpiry,
  setAuthCookie,
  clearAuthCookie,
} from '../auth.js';
import { audit, clientMeta } from '../middleware/auth.js';
import {
  ALLOW_SELF_REGISTER_STUDENT,
  INVITE_TTL_DAYS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_WINDOW_MINUTES,
  ALLOW_GUEST,
  GUEST_TTL_HOURS,
} from '../config.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const MIN_PASSWORD = 6;

function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

/** 建登录态 + 下发 Cookie + 回写最后登录时间 */
function establishLogin(req, res, userRow) {
  const token = generateToken();
  const expiresAt = sessionExpiry();
  insertUserSession({ token, user_id: userRow.id, expires_at: expiresAt, ...clientMeta(req) });
  setAuthCookie(res, token);
  touchUserLogin(userRow.id);
  return token;
}

// POST /api/auth/register
export function register(req, res) {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'parent' ? 'parent' : 'student';
    const displayName = String(body.display_name || '').trim().slice(0, 40) || null;
    const inviteCode = String(body.invite_code || '').trim().toUpperCase();

    if (!USERNAME_RE.test(username)) return bad(res, '用户名需为 3-32 位字母、数字或下划线');
    if (password.length < MIN_PASSWORD) return bad(res, `密码至少 ${MIN_PASSWORD} 位`);
    if (getUserByUsername(username)) return bad(res, '该用户名已被占用', 409);

    // 学生：默认须凭家长邀请码注册（避免游离子空间）；家长：自由注册
    let parentId = null;
    if (role === 'student') {
      if (inviteCode) {
        const inv = getInviteCode(inviteCode);
        const now = Math.floor(Date.now() / 1000);
        if (!inv || inv.kind === 'bind' || inv.used_by || (inv.expires_at && inv.expires_at <= now)) {
          return bad(res, '邀请码无效、已使用或已过期');
        }
        parentId = inv.parent_id;
      } else if (!ALLOW_SELF_REGISTER_STUDENT) {
        return bad(res, '学生注册需要家长提供的邀请码（或由家长代为创建账号）');
      }
    }

    const created = createUser({
      role,
      username,
      display_name: displayName,
      password_hash: hashPassword(password),
      is_admin: 0,
    });

    if (role === 'student' && parentId) {
      linkParentChild(parentId, created.id);
      redeemInviteCode(inviteCode, created.id); // 核销（回填 used_by）
    }

    const row = getUserRowByUsername(username);
    establishLogin(req, res, row);

    const user = getUserById(created.id);
    user.children = [];
    audit(req, 'register', { actor: user, target_type: 'user', target_id: user.id, detail: `role=${role}${parentId ? ' via_invite' : ''}` });
    res.json({ ok: true, user, linked_parent: !!parentId });
  } catch (e) {
    console.error('[auth] register failed:', e);
    res.status(500).json({ error: e.message || '注册失败' });
  }
}

// POST /api/auth/login
export function login(req, res) {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const { ip, user_agent } = clientMeta(req);
  try {
    if (!username || !password) return bad(res, '请输入用户名和密码');

    // ---- 限流：同一「用户名+IP」失败超限（主防线）或同一 IP 撞库超限（次防线）即拒绝 ----
    const windowSeconds = Math.max(1, LOGIN_WINDOW_MINUTES) * 60;
    const fails = countRecentFailedAttempts({ username, ip, windowSeconds });
    if (fails.by_user_ip >= LOGIN_MAX_ATTEMPTS || fails.by_ip >= LOGIN_IP_MAX_ATTEMPTS) {
      recordLoginAttempt({ username, ip, success: 0, reason: 'rate_limited', user_agent });
      audit(req, 'login_blocked', {
        actor: { username },
        detail: `by_user_ip=${fails.by_user_ip} by_ip=${fails.by_ip}`,
      });
      return res.status(429).json({
        error: `登录失败次数过多，请 ${LOGIN_WINDOW_MINUTES} 分钟后再试`,
        retry_after_minutes: LOGIN_WINDOW_MINUTES,
      });
    }

    const row = getUserRowByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) {
      recordLoginAttempt({ username, ip, success: 0, reason: 'bad_credentials', user_agent });
      audit(req, 'login_failed', { actor: { username }, detail: 'bad_credentials' });
      return bad(res, '用户名或密码错误', 401);
    }
    if (row.status !== 'active') {
      recordLoginAttempt({ username, ip, success: 0, reason: 'disabled', user_agent });
      audit(req, 'login_failed', { actor: { username }, detail: 'account_disabled' });
      return bad(res, '账号已被停用', 403);
    }

    recordLoginAttempt({ username, ip, success: 1, reason: null, user_agent });
    establishLogin(req, res, row);

    const user = getUserById(row.id);
    user.children = row.role === 'parent' ? listChildren(row.id) : [];
    audit(req, 'login_success', { actor: user, target_type: 'user', target_id: user.id, detail: user.is_guest ? 'guest' : null });
    res.json({ ok: true, user });
  } catch (e) {
    console.error('[auth] login failed:', e);
    res.status(500).json({ error: e.message || '登录失败' });
  }
}

// POST /api/auth/guest —— 游客试用（无需注册，数据挂在临时账号名下，到期自动清理）
export function guestLogin(req, res) {
  try {
    if (!ALLOW_GUEST) return bad(res, '当前未开放游客试用，请先注册', 403);

    const username = nextGuestUsername();
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(0.1, GUEST_TTL_HOURS) * 3600;
    const created = createUser({
      role: 'student',
      username,
      display_name: '游客',
      password_hash: hashPassword(generateToken()), // 随机密码：游客无需（也不能）用密码登录
      is_admin: 0,
      guest_expires_at: expiresAt,
    });

    const row = getUserRowByUsername(username);
    establishLogin(req, res, row);

    const user = getUserById(created.id);
    user.children = [];
    audit(req, 'guest_start', { actor: user, target_type: 'user', target_id: user.id, detail: `ttl=${GUEST_TTL_HOURS}h` });
    res.json({ ok: true, user, guest_expires_at: expiresAt });
  } catch (e) {
    console.error('[auth] guest login failed:', e);
    res.status(500).json({ error: e.message || '开启试用失败' });
  }
}

// POST /api/auth/logout
export function logout(req, res) {
  try {
    if (req.authToken) deleteUserSession(req.authToken);
    clearAuthCookie(res);
    audit(req, 'logout');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/auth/me
export function me(req, res) {
  res.json({ user: req.user });
}

// POST /api/auth/password —— 登录用户修改自己的密码
// 改密后保留当前会话、踢掉其它设备的登录（旧 Cookie 立即失效）
export function changePassword(req, res) {
  try {
    const body = req.body || {};
    const oldPassword = String(body.old_password || '');
    const newPassword = String(body.new_password || '');
    if (!oldPassword || !newPassword) return bad(res, '请填写原密码与新密码');
    if (newPassword.length < MIN_PASSWORD) return bad(res, `新密码至少 ${MIN_PASSWORD} 位`);
    if (newPassword === oldPassword) return bad(res, '新密码不能与原密码相同');

    const row = getUserRowByUsername(req.user.username);
    if (!row || !verifyPassword(oldPassword, row.password_hash)) {
      audit(req, 'password_change_failed', { target_type: 'user', target_id: req.user.id, detail: 'bad_old_password' });
      return bad(res, '原密码不正确', 400);
    }

    updateUserPassword(req.user.id, hashPassword(newPassword));
    if (req.authToken) deleteUserSessionsOfUser(req.user.id, req.authToken);
    audit(req, 'password_change', { target_type: 'user', target_id: req.user.id });
    res.json({ ok: true, note: '其它设备的登录已失效，请用新密码重新登录' });
  } catch (e) {
    console.error('[auth] changePassword failed:', e);
    res.status(500).json({ error: e.message || '修改密码失败' });
  }
}

// POST /api/auth/invite —— 家长生成「孩子注册」邀请码
export function invite(req, res) {
  try {
    if (req.user.role !== 'parent') return bad(res, '仅家长可生成邀请码', 403);
    const code = generateInviteCode();
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(1, INVITE_TTL_DAYS) * 86400;
    createInviteCode({ code, parent_id: req.user.id, expires_at: expiresAt, kind: 'register' });
    audit(req, 'invite_create', { target_type: 'invite', target_id: code });
    res.json({ ok: true, code, kind: 'register', expires_at: expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message || '生成邀请码失败' });
  }
}

// GET /api/auth/invites —— 家长查看自己的邀请码 / 绑定码
export function invites(req, res) {
  try {
    if (req.user.role !== 'parent') return bad(res, '仅家长可查看邀请码', 403);
    const now = Math.floor(Date.now() / 1000);
    const rows = listInviteCodes(req.user.id).map((r) => ({
      code: r.code,
      kind: r.kind || 'register',
      target_student_id: r.target_student_id || null,
      expires_at: r.expires_at,
      used_by: r.used_by,
      created_at: r.created_at,
      expired: !!(r.expires_at && r.expires_at <= now),
    }));
    res.json({ invites: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/children —— 家长查看已绑定孩子
export function children(req, res) {
  try {
    if (req.user.role !== 'parent') return bad(res, '仅家长可查看孩子列表', 403);
    res.json({ children: listChildren(req.user.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
