// 对话 turn controller（SSE 流式响应）
import { sessions } from '../session.js';

// POST /api/session/:id/turn
export async function handleTurn(req, res) {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'session not found' });

  const body = req.body || {};
  const message = body.message;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'missing message' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {}\n\n');

  const onMessage = (msg) => {
    try {
      res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
    } catch {
      /* ignore */
    }
  };

  s.on('message', onMessage);

  // 心跳保活
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    s.off('message', onMessage);
  };

  req.on('close', () => {
    cleanup();
    s.closed = true;
  });

  try {
    await s.queue.push({
      type: 'user',
      message: { role: 'user', content: message },
      session_id: s.id,
      shouldQuery: true,
    });
  } catch (err) {
    console.error('[turn] error:', err);
    try {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`,
      );
    } catch {
      /* ignore */
    }
  }
}
