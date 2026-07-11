// 会话管理 controller
import {
  sessions,
  createSession,
  destroySession,
  clearSessionHistory,
  resetSession,
} from '../session.js';

// POST /api/session
export function createSessionHandler(req, res) {
  const body = req.body || {};
  const s = createSession(body);
  res.json({
    id: s.id,
    mode: s.mode,
    currentProblemId: s.currentProblemId,
  });
}

// GET /api/session/:id
export function getSession(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({
    id: s.id,
    mode: s.mode,
    currentProblemId: s.currentProblemId,
    createdAt: s.createdAt,
  });
}

// DELETE /api/session/:id
export async function deleteSession(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (s) await destroySession(s);
  res.json({ ok: true });
}

// POST /api/session/:id/clear
export async function clearSession(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
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
  const newSession = await resetSession(oldId, body);
  res.json({
    ok: true,
    id: newSession.id,
    mode: newSession.mode,
    currentProblemId: newSession.currentProblemId,
  });
}

// POST /api/session/:id/scratch
export function syncScratch(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const body = req.body || {};
  s.scratchStrokes = body.strokes || 0;
  res.json({ ok: true });
}

// POST /api/session/:id/scratch-image
export function syncScratchImage(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const body = req.body || {};
  if (body.image !== undefined) {
    s.scratchImage = body.image;
  }
  if (typeof body.strokes === 'number') s.scratchStrokes = body.strokes;
  res.json({ ok: true });
}

// POST /api/session/:id/delete-confirm
export function deleteConfirm(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
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
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });
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
