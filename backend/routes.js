// HTTP 路由处理
import fs from 'node:fs';
import path from 'node:path';
import { STATIC_ROOT } from './config.js';
import { sessions, createSession, destroySession, clearSessionHistory, resetSession, abortTurn } from './session.js';
import {
  getProblemsForClient, getProblem, getAllProblems,
  insertProblem, updateProblemFigure, deleteProblem, updateChatSession
} from './db.js';
import { send, sendSSE, readJsonBody } from './utils.js';

// 静态文件服务
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(STATIC_ROOT, p);
  if (!filePath.startsWith(STATIC_ROOT)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'not found: ' + p });
    const ext = path.extname(p).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  });
}

/**
 * 处理 HTTP 请求（主路由分发）
 */
export async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;

  // 健康检查（云端部署/负载均衡用）
  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/api/health')) {
    return send(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      sessions: sessions.size,
      problems: getAllProblems().length,
      version: '0.1.0'
    });
  }

  // ---------- 题目 API ----------
  if (req.method === 'GET' && pathname === '/api/problems') {
    return send(res, 200, getProblemsForClient());
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/problem/')) {
    const id = decodeURIComponent(pathname.split('/').slice(3).join('/'));
    if (!id) return send(res, 400, { error: 'missing id' });
    const p = getProblem(id);
    const removed = deleteProblem(id);
    const remaining = getAllProblems();
    const nextId = remaining.length ? remaining[0].id : null;
    for (const s of sessions.values()) {
      if (s.currentProblemId === id) s.currentProblemId = nextId;
    }
    return send(res, 200, { ok: removed, id, had: !!p, remaining: remaining.length, current_problem_id: nextId });
  }

  // ---------- 会话 API ----------
  if (req.method === 'POST' && pathname === '/api/session') {
    const body = await readJsonBody(req).catch(() => ({}));
    const s = createSession(body);
    return send(res, 200, { id: s.id, mode: s.mode, currentProblemId: s.currentProblemId });
  }

  // 查询 session 是否存在（刷新页面时恢复用）
  if (req.method === 'GET' && pathname.match(/^\/api\/session\/[^/]+$/)) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    return send(res, 200, { id: s.id, mode: s.mode, currentProblemId: s.currentProblemId, createdAt: s.createdAt });
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/session/')) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (s) await destroySession(s);
    return send(res, 200, { ok: true });
  }

  // 中止当前 AI 回复（用户取消）
  if (req.method === 'POST' && pathname.match(/^\/api\/session\/[^/]+\/abort$/)) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    await abortTurn(s);
    return send(res, 200, { ok: true });
  }

  // 清空会话历史（保留 session ID，重置 SDK 进程）
  if (req.method === 'POST' && pathname.match(/^\/api\/session\/[^/]+\/clear$/)) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    await clearSessionHistory(s);
    return send(res, 200, { ok: true, id: s.id, mode: s.mode, currentProblemId: s.currentProblemId });
  }

  // 新建会话覆盖老会话（销毁旧 session，创建新 session，返回新 ID）
  if (req.method === 'POST' && pathname.match(/^\/api\/session\/[^/]+\/reset$/)) {
    const oldId = pathname.split('/')[3];
    const body = await readJsonBody(req).catch(() => ({}));
    const newSession = await resetSession(oldId, body);
    return send(res, 200, { ok: true, id: newSession.id, mode: newSession.mode, currentProblemId: newSession.currentProblemId });
  }

  // ---------- 草稿同步 ----------
  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/scratch')) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    const body = await readJsonBody(req);
    s.scratchStrokes = body.strokes || 0;
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/scratch-image')) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    const body = await readJsonBody(req);
    if (body.image !== undefined) {
      s.scratchImage = body.image;
    }
    if (typeof body.strokes === 'number') s.scratchStrokes = body.strokes;
    return send(res, 200, { ok: true });
  }

  // ---------- 删除确认（学生对 delete_proposed 的应答）----------
  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/delete-confirm')) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    const body = await readJsonBody(req);
    const delId = (s.pendingDelete && s.pendingDelete.problem_id) || body.problem_id;
    if (body.action === 'accept' && delId) {
      if (getProblem(delId)) {
        deleteProblem(delId);
        if (s.proposedProblems) {
          s.proposedProblems = s.proposedProblems.filter(x => x.id !== delId);
        }
        const remaining = getAllProblems();
        const nextId = remaining.length ? remaining[0].id : null;
        if (s.currentProblemId === delId) s.currentProblemId = nextId;
        s.emit('ui_event', { type: 'problems_changed', deleted_id: delId, current_problem_id: nextId });
      }
    }
    try {
      s.queue.push({
        type: 'user',
        message: {
          role: 'user',
          content: `[系统通知] 学生${body.action === 'accept' ? '已确认删除题目' : '取消了删除操作'}${delId ? ': ' + delId : ''}`
        },
        parent_tool_use_id: null,
        session_id: s.id,
        shouldQuery: false
      });
    } catch { /* ignore */ }
    s.pendingDelete = null;
    return send(res, 200, { ok: true });
  }

  // ---------- 出题确认（学生对 propose_problem 的应答）----------
  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/proposal')) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    const body = await readJsonBody(req);
    if (body.action === 'accept' && body.problem_id) {
      const p = (s.proposedProblems || []).find(x => x.id === body.problem_id);
      if (p) {
        if (!getProblem(p.id)) {
          insertProblem({
            id: p.id,
            topic: p.topic,
            text: p.text,
            answer: p.answer,
            hints: p.hints,
            figure: p.figure,
            imageDataUrl: p.figureImage || null,
            source: 'ai'
          });
          if (p.figure && p.figure.type === 'image' && p.figureImage) {
            updateProblemFigure(p.id, p.figure, p.figureImage);
          }
          console.log(`[db] saved AI problem: ${p.id} (${p.topic})`);
        }
        s.currentProblemId = p.id;
        updateChatSession(s.id, { current_problem_id: p.id });
      }
    }
    try {
      s.queue.push({
        type: 'user',
        message: {
          role: 'user',
          content: `[系统通知] 学生${body.action === 'accept' ? '已确认替换为新题' : '取消了'}提议: ${body.problem_id}`
        },
        parent_tool_use_id: null,
        session_id: s.id,
        shouldQuery: false
      });
    } catch { /* ignore */ }
    return send(res, 200, { ok: true });
  }

  // ---------- Turn（SSE 流式对话）----------
  if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/turn')) {
    const id = pathname.split('/')[3];
    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'session not found' });
    const body = await readJsonBody(req);
    const userMsg = (body.message || '').trim();
    const imgBody = body.image;
    const audioBody = body.audio;
    if (!userMsg && !imgBody && !audioBody) return send(res, 400, { error: 'empty message' });
    if (typeof body.currentProblemId === 'string') s.currentProblemId = body.currentProblemId;
    if (typeof body.scratchStrokes === 'number') s.scratchStrokes = body.scratchStrokes;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    });
    sendSSE(res, 'user', { message: userMsg, hasImage: !!imgBody, hasAudio: !!audioBody });

    const unsubscribe = s.subscribe((event, data) => {
      sendSSE(res, event, data);
      if (event === 'sdk_message' && data.type === 'result') {
        sendSSE(res, 'done', {});
        setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
      } else if (event === 'error') {
        sendSSE(res, 'done', {});
        setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
      }
    });
    req.on('close', () => { unsubscribe(); });

    try {
      let effectiveText = userMsg || '';
      if (imgBody && imgBody.data) {
        s.lastImage = `data:${imgBody.mediaType || 'image/jpeg'};base64,${imgBody.data}`;
        if (effectiveText && !/(图片|image|照片|上传|识别)/i.test(effectiveText)) {
          effectiveText += '\n\n（学生刚刚上传了一张图片。如果你需要查看图片内容，请调用 recognize_problem_image 工具。）';
        } else if (!effectiveText) {
          effectiveText = '（学生上传了一张图片，请调用 recognize_problem_image 工具识别图片内容。）';
        }
      }
      const content = [];
      if (audioBody && audioBody.data) {
        content.push({ type: 'audio', source: { type: 'base64', media_type: audioBody.mediaType || 'audio/webm', data: audioBody.data } });
      }
      if (effectiveText) {
        content.push({ type: 'text', text: effectiveText });
      }
      if (content.length === 0) {
        sendSSE(res, 'error', { message: '消息内容为空' });
        sendSSE(res, 'done', {});
        setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
        return;
      }
      const finalContent = content.length === 1 && content[0].type === 'text' ? content[0].text : content;

      s.queue.push({
        type: 'user',
        message: { role: 'user', content: finalContent },
        parent_tool_use_id: null,
        session_id: s.id
      });
    } catch (e) {
      sendSSE(res, 'error', { message: '消息入队失败: ' + (e.message || String(e)) });
      sendSSE(res, 'done', {});
      setImmediate(() => { try { res.end(); } catch { /* ignore */ } });
    }
    return;
  }

  // ---------- 静态文件 ----------
  return serveStatic(req, res, pathname);
}
