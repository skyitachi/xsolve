// 家长与孩子（用户系统 P1）
//   - 家长查看自己的孩子（含学习统计）
//   - 家长查看孩子的会话列表 / 学习档案（只读；档案复用 /api/memory/*）
//   - 绑定码：一个学生可被多位家长绑定（multi-parent）
// 所有写操作都过 requireParentOf（学生本人也可为「自己」生成绑定码）。
import {
  listChildren,
  getChildStats,
  listChatSessions,
  getUserById,
  isBoundChild,
  linkParentChild,
  unlinkParentChild,
  getInviteCode,
  createInviteCode,
  redeemInviteCode,
  listBindCodesOfStudent,
  listInviteCodes,
} from '../db.js';
import { generateInviteCode } from '../auth.js';
import { audit } from '../middleware/auth.js';
import { INVITE_TTL_DAYS } from '../config.js';

function fail(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

/** 码的有效期时间戳 */
function codeExpiry(days = INVITE_TTL_DAYS) {
  return Math.floor(Date.now() / 1000) + Math.max(1, days) * 86400;
}

// GET /api/family/children —— 我绑定的孩子（含学习统计）
export function familyChildren(req, res) {
  try {
    if (req.user.role !== 'parent' && !req.user.is_admin) {
      return fail(res, '仅家长可查看孩子列表', 403);
    }
    const rows = req.user.role === 'parent'
      ? listChildren(req.user.id)
      : listChildren(req.query.parentId || req.user.id);
    const children = rows.map((c) => {
      let stats = null;
      try { stats = getChildStats(c.id); } catch (e) { console.error('[family] stats failed:', e.message); }
      return { ...c, stats };
    });
    res.json({ children });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/family/children/:studentId/sessions —— 孩子的会话列表（只读）
export function familyChildSessions(req, res) {
  try {
    const sid = req.targetStudentId;
    const rows = listChatSessions(undefined, { studentId: sid });
    res.json({
      student_id: sid,
      student: getUserById(sid),
      sessions: rows.map((r) => ({
        id: r.id,
        role: r.role,
        title: r.title,
        currentProblemId: r.current_problem_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/family/bind-codes —— 生成「家长绑定码」
//   body.studentId 缺省时：学生=自己；家长=第一个孩子
export function createBindCode(req, res) {
  try {
    const body = req.body || {};
    let studentId = body.studentId || body.student_id || null;

    if (req.user.role === 'student') {
      studentId = req.user.id;
    } else if (req.user.role === 'parent') {
      const kids = req.user.children || [];
      if (!studentId) {
        if (!kids.length) return fail(res, '尚未绑定孩子');
        studentId = kids[0].id;
      } else if (!kids.some((c) => c.id === studentId)) {
        return fail(res, '仅可为已绑定孩子生成绑定码', 403);
      }
    } else if (!studentId) {
      return fail(res, '管理员需指定 studentId');
    }

    const target = getUserById(studentId);
    if (!target) return fail(res, '学生不存在', 404);
    if (target.role !== 'student') return fail(res, '只能为学生生成绑定码');

    const code = generateInviteCode();
    const expiresAt = codeExpiry();
    createInviteCode({ code, parent_id: req.user.id, expires_at: expiresAt, kind: 'bind', target_student_id: studentId });
    audit(req, 'bind_code_create', { target_type: 'user', target_id: studentId, detail: `code=${code}` });
    res.json({ ok: true, code, kind: 'bind', student_id: studentId, expires_at: expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message || '生成绑定码失败' });
  }
}

// GET /api/family/bind-codes?studentId= —— 该学生现有的可用绑定码
//   学生：强制自己；家长：必须是已绑定孩子；管理员：任意（绑定码是密钥，必须校验归属）
export function listBindCodes(req, res) {
  try {
    let sid = req.query.studentId || req.query.student_id || null;
    if (req.user.role === 'student') {
      sid = req.user.id;
    } else if (req.user.role === 'parent') {
      const kids = req.user.children || [];
      if (!sid) {
        if (!kids.length) return fail(res, '尚未绑定孩子');
        sid = kids[0].id;
      } else if (!kids.some((c) => c.id === sid)) {
        return fail(res, '仅可查看已绑定孩子的绑定码', 403);
      }
    }
    if (!sid) return fail(res, '未指定学生');

    const now = Math.floor(Date.now() / 1000);
    const rows = listBindCodesOfStudent(sid)
      .filter((r) => !r.used_by)
      .map((r) => ({ code: r.code, expires_at: r.expires_at, expired: !!(r.expires_at && r.expires_at <= now), created_at: r.created_at }));
    res.json({ student_id: sid, codes: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// POST /api/family/bind —— 家长凭「学生绑定码」绑定该学生（支持多家长）
export function bindByCode(req, res) {
  try {
    if (req.user.role !== 'parent') return fail(res, '仅家长可绑定学生', 403);
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    if (!code) return fail(res, '请输入绑定码');

    const row = getInviteCode(code);
    if (!row || row.kind !== 'bind') return fail(res, '绑定码无效');
    if (row.used_by) return fail(res, '绑定码已被使用');
    if (row.expires_at && row.expires_at <= Math.floor(Date.now() / 1000)) return fail(res, '绑定码已过期');
    const studentId = row.target_student_id;
    if (!studentId) return fail(res, '绑定码缺少目标学生');

    const target = getUserById(studentId);
    if (!target || target.role !== 'student') return fail(res, '目标学生不存在', 404);

    // 已经绑定过 → 幂等成功，但仍核销码以免被复用
    const already = isBoundChild(req.user.id, studentId);
    const consumed = redeemInviteCode(code, req.user.id);
    if (!consumed && !already) return fail(res, '绑定码已被使用');

    linkParentChild(req.user.id, studentId, (req.body || {}).relation || null);
    audit(req, 'child_bind', { target_type: 'user', target_id: studentId, detail: already ? 'already_bound' : 'new' });

    const children = listChildren(req.user.id);
    res.json({ ok: true, already_bound: already, student: target, children });
  } catch (e) {
    res.status(500).json({ error: e.message || '绑定失败' });
  }
}

// DELETE /api/family/children/:studentId —— 解绑（不影响孩子账号与数据）
export function unbindChild(req, res) {
  try {
    const sid = req.targetStudentId;
    unlinkParentChild(req.user.id, sid);
    audit(req, 'child_unbind', { target_type: 'user', target_id: sid });
    res.json({ ok: true, children: listChildren(req.user.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/family/invites —— 我发出的全部码（注册码 + 绑定码）
export function myInvites(req, res) {
  try {
    if (req.user.role !== 'parent') return fail(res, '仅家长可查看', 403);
    const now = Math.floor(Date.now() / 1000);
    res.json({
      invites: listInviteCodes(req.user.id).map((r) => ({
        code: r.code,
        kind: r.kind || 'register',
        target_student_id: r.target_student_id || null,
        expires_at: r.expires_at,
        used_by: r.used_by,
        created_at: r.created_at,
        expired: !!(r.expires_at && r.expires_at <= now),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
