// 通用工具函数

// 答案容错比较
export function compareAnswer(u, c) {
  const norm = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/，/g, ",");
  const U = norm(u),
    C = norm(c);
  if (U === C) return true;
  const un = parseFloat(U),
    cn = parseFloat(C);
  if (!isNaN(un) && !isNaN(cn) && Math.abs(un - cn) < 1e-6) return true;
  if (U.includes(C) || C.includes(U)) return true;
  return false;
}

// 安全计算（只允许数字和基本运算符）
export function safeCalc(expr) {
  if (!/^[\d+\-*/().\s]+$/.test(expr))
    throw new Error("only digits, + - * / ( ) allowed");
  // eslint-disable-next-line no-new-func
  const v = Function('"use strict";return (' + expr + ")")();
  if (typeof v !== "number" || !isFinite(v))
    throw new Error("not a finite number");
  return v;
}

// HTTP 响应辅助
export function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// SSE 事件发送
export function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 读取 JSON 请求体
export function readJsonBody(req, maxBytes = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// 流式输入队列：把 fetch 的 user message 推给 SDK
export function createInputQueue() {
  const buf = [];
  let resolver = null;
  let closed = false;
  return {
    push(msg) {
      if (closed) return;
      if (resolver) {
        const r = resolver;
        resolver = null;
        r({ value: msg, done: false });
      } else buf.push(msg);
    },
    close() {
      closed = true;
      if (resolver) {
        const r = resolver;
        resolver = null;
        r({ value: undefined, done: true });
      }
    },
    iterable() {
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (buf.length)
            return Promise.resolve({ value: buf.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => {
            resolver = r;
          });
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// MCP 工具返回值辅助
export function mcpOk(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
export function mcpErr(msg) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    isError: true,
  };
}
