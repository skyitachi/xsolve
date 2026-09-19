// 会话管理 controller
import crypto from 'node:crypto';
import {
  sessions,
  createSession,
  destroySession,
  clearSessionHistory,
  resetSession,
  restoreSession,
  canAccessSession,
  canAccessSessionRow,
} from '../session.js';
import {
  listChatSessions,
  getChatSession,
  getChatTurns,
  deleteChatSession,
  updateChatSession,
} from '../db.js';

/**
 * 取内存中的会话并校验归属。
 * @returns {object|null} 通过校验的 session；否则已写好 404/403 响应，返回 null
 */
function ownedSession(req, res, id) {
  const s = sessions.get(id);
  if (!s) {
    // 内存没有 → 尝试从 DB 恢复（带归属校验）
    const restored = restoreSession(id, req.user);
    if (!restored) {
      // 区分「不存在」与「无权限」
      const row = getChatSession(id);
      if (row && !canAccessSessionRow(req.user, row)) {
        res.status(403).json({ error: '无权访问该会话' });
      } else {
        res.status(404).json({ error: 'session not found' });
      }
      return null;
    }
    return restored;
  }
  if (!canAccessSession(req.user, s)) {
    res.status(403).json({ error: '无权访问该会话' });
    return null;
  }
  return s;
}

// POST /api/session
export function createSessionHandler(req, res) {
  try {
    const s = createSession({ ...(req.body || {}), user: req.user });
    res.json({
      id: s.id,
      mode: s.mode,
      studentId: s.studentId,
      currentProblemId: s.currentProblemId,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

// GET /api/session/:id
export function getSession(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  res.json({
    id: s.id,
    mode: s.mode,
    studentId: s.studentId,
    currentProblemId: s.currentProblemId,
    createdAt: s.createdAt,
  });
}

// DELETE /api/session/:id
export async function deleteSession(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  await destroySession(s);
  res.json({ ok: true });
}

// GET /api/sessions?role=student
export function listSessions(req, res) {
  const role = req.query.role;
  const user = req.user;
  // 学生：只看自己拥有的；家长：看自己拥有的 + 已绑定孩子的（只读查看）
  let rows;
  if (!user || user.is_admin || user.role === 'admin') {
    rows = listChatSessions(role);
  } else {
    const own = listChatSessions(role, { userId: user.id });
    const seen = new Set(own.map((r) => r.id));
    const merged = [...own];
    for (const c of (user.children || [])) {
      for (const r of listChatSessions(role, { studentId: c.id })) {
        if (!seen.has(r.id)) { seen.add(r.id); merged.push(r); }
      }
    }
    rows = merged.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }
  res.json(rows.map(r => ({
    id: r.id,
    role: r.role,
    title: r.title,
    currentProblemId: r.current_problem_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
}

// GET /api/session/:id/history
export function getSessionHistory(req, res) {
  const id = req.params.id;
  const dbRow = getChatSession(id);
  if (!dbRow) return res.status(404).json({ error: 'session not found' });
  if (!canAccessSessionRow(req.user, dbRow)) {
    return res.status(403).json({ error: '无权访问该会话' });
  }
  const turns = getChatTurns(id);
  res.json({
    session: {
      id: dbRow.id,
      role: dbRow.role,
      title: dbRow.title,
      currentProblemId: dbRow.current_problem_id,
    },
    turns: turns.map(t => ({
      id: t.id,
      userMessage: t.user_message,
      aiMessage: t.ai_message,
      toolCalls: JSON.parse(t.tool_calls_json || '[]'),
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      durationMs: t.duration_ms,
      error: t.error,
      createdAt: t.created_at,
    })),
  });
}

// GET /api/session/:id (覆写：支持从 DB 恢复)
export function getSessionOrRestore(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  res.json({
    id: s.id,
    mode: s.mode,
    studentId: s.studentId,
    currentProblemId: s.currentProblemId,
    createdAt: s.createdAt,
  });
}

// POST /api/session/:id/archive
export function archiveSession(req, res) {
  const id = req.params.id;
  const row = getChatSession(id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  if (!canAccessSessionRow(req.user, row)) return res.status(403).json({ error: '无权访问该会话' });
  updateChatSession(id, { is_archived: 1 });
  res.json({ ok: true });
}

// PATCH /api/session/:id — 更新 session 状态（如 currentProblemId）
export function patchSession(req, res) {
  const id = req.params.id;
  const body = req.body || {};
  const row = getChatSession(id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  if (!canAccessSessionRow(req.user, row)) return res.status(403).json({ error: '无权访问该会话' });
  const s = sessions.get(id);
  if (body.currentProblemId !== undefined) {
    if (s) s.currentProblemId = body.currentProblemId;
    updateChatSession(id, { current_problem_id: body.currentProblemId });
  }
  res.json({ ok: true });
}

// DELETE /api/session/:id (覆写：同时删 DB)
export async function deleteSessionWithDb(req, res) {
  const id = req.params.id;
  const row = getChatSession(id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  if (!canAccessSessionRow(req.user, row)) return res.status(403).json({ error: '无权访问该会话' });
  const s = sessions.get(id);
  if (s) await destroySession(s);
  deleteChatSession(id);
  res.json({ ok: true });
}

// POST /api/session/:id/clear
export async function clearSession(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  await clearSessionHistory(s);
  res.json({
    ok: true,
    id: s.id,
    mode: s.mode,
    currentProblemId: s.currentProblemId,
  });
}

// POST /api/session/:id/reset
export async function resetSessionHandler(req, res) {
  const oldId = req.params.id;
  const body = req.body || {};
  try {
    const newSession = await resetSession(oldId, { ...body, user: req.user });
    res.json({
      ok: true,
      id: newSession.id,
      mode: newSession.mode,
      studentId: newSession.studentId,
      currentProblemId: newSession.currentProblemId,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

// 草稿图的指纹：图一变（新笔画 / 擦除 / 清空）指纹就变。
// turnController 用它判断缓存的识别结果是否还有效，避免每轮都调视觉模型。
function scratchRevisionOf(image) {
  if (!image) return null;
  return crypto.createHash('md5').update(String(image)).digest('hex').slice(0, 12);
}

// 草稿图变化时作废旧的识别缓存（下一轮会重新识别）
function invalidateScratchOcr(s) {
  const rev = scratchRevisionOf(s.scratchImage);
  if (rev !== (s.scratchRevision || null)) {
    s.scratchOcr = null;
    s.scratchOcrRevision = null;
  }
  s.scratchRevision = rev;
}

// POST /api/session/:id/scratch
export function syncScratch(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  const body = req.body || {};
  s.scratchStrokes = body.strokes || 0;
  // 笔画数归零 = 画布被清空，服务端缓存图与识别结果一并作废
  if (s.scratchStrokes === 0 && s.scratchImage) {
    s.scratchImage = null;
    invalidateScratchOcr(s);
  }
  res.json({ ok: true });
}

// POST /api/session/:id/scratch-image
export function syncScratchImage(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  const body = req.body || {};
  if (body.image !== undefined) {
    s.scratchImage = body.image || null; // null = 前端画布已清空
    invalidateScratchOcr(s);
  }
  if (typeof body.strokes === 'number') s.scratchStrokes = body.strokes;
  res.json({ ok: true });
}

// POST /api/session/:id/delete-confirm
export function deleteConfirm(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  const body = req.body || {};
  const delId = (s.pendingDelete && s.pendingDelete.problem_id) || body.problem_id;

  if (body.action === 'accept' && delId) {
    // 需要在此处导入 db 函数，避免循环依赖
    import('../db.js').then(({ getProblem, deleteProblem, getAllProblems }) => {
      if (getProblem(delId)) {
        deleteProblem(delId);
        if (s.proposedProblems) {
          s.proposedProblems = s.proposedProblems.filter((x) => x.id !== delId);
        }
        const remaining = getAllProblems();
        const nextId = remaining.length ? remaining[0].id : null;
        if (s.currentProblemId === delId) s.currentProblemId = nextId;
        s.emit('ui_event', {
          type: 'problems_changed',
          deleted_id: delId,
          current_problem_id: nextId,
        });
      }
    });
  }

  try {
    s.queue.push({
      type: 'user',
      message: {
        role: 'user',
        content: `[系统通知] 学生${body.action === 'accept' ? '已确认删除题目' : '取消了删除操作'}${delId ? ': ' + delId : ''}`,
      },
      parent_tool_use_id: null,
      session_id: s.id,
      shouldQuery: false,
    });
  } catch {
    /* ignore */
  }
  s.pendingDelete = null;
  res.json({ ok: true });
}

// POST /api/session/:id/proposal
export function proposalConfirm(req, res) {
  const s = ownedSession(req, res, req.params.id);
  if (!s) return;
  const body = req.body || {};

  if (body.action === 'accept' && body.problem_id) {
    const p = (s.proposedProblems || []).find((x) => x.id === body.problem_id);
    if (p) {
      import('../db.js').then(({ getProblem, insertProblem, updateProblemFigure }) => {
        if (!getProblem(p.id)) {
          insertProblem({
            id: p.id,
            topic: p.topic,
            text: p.text,
            answer: p.answer,
            hints: p.hints,
            figure: p.figure,
            imageDataUrl: p.figureImage || null,
            source: 'ai',
          });
          if (p.figure && p.figure.type === 'image' && p.figureImage) {
            updateProblemFigure(p.id, p.figure, p.figureImage);
          }
          console.log(`[db] saved AI problem: ${p.id} (${p.topic})`);
        }
        s.currentProblemId = p.id;
      });
    }
  }

  try {
    s.queue.push({
      type: 'user',
      message: {
        role: 'user',
        content: `[系统通知] 学生${body.action === 'accept' ? '已确认替换为新题' : '取消了'}提议: ${body.problem_id}`,
      },
      parent_tool_use_id: null,
      session_id: s.id,
      shouldQuery: false,
    });
  } catch {
    /* ignore */
  }
  res.json({ ok: true });
}
