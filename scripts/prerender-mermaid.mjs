#!/usr/bin/env node
/**
 * 把 HTML 文档里的 <div class="mermaid"> 预渲染成**内联静态 SVG**。
 *
 * 为什么需要：
 *   设计文档要求离线自包含。而预览面板 / 沙箱环境经常「禁用 JS」或「禁止加载相对路径脚本」，
 *   此时运行时 mermaid 不执行，图会退化成一整段原始代码文字（表现为「图显示异常 / 出图失败」）。
 *   把 SVG 预渲染后内联进 HTML，就与 JS 无关了。
 *
 * 用法：
 *   node scripts/prerender-mermaid.mjs docs/<topic>/<topic>.html
 *
 * 它会：
 *   1. 抽出所有 <div class="mermaid"> 的源码
 *   2. 生成同目录的 _prerender.html（临时，含 mermaid.min.js 引用）
 *   3. 用无头 Chrome + CDP 等图渲染完，校验没有 error 框
 *   4. 把 <div class="mermaid"> 替换为 <script type="text/plain" class="mermaid-source"> + 内联 <svg>
 *   5. 删除 _prerender.html
 *
 * 依赖：_shared/js/mermaid.min.js 必须已复制到文档同目录（相对路径 ./_shared/js/...）
 *
 * 三个已踩过的坑（都表现为「Page.enable 超时」）：
 *   ① 别用 GET /json/new 建标签页 —— 必须 PUT；或直接从 /json/list 取现成的 about:blank
 *   ② 别把目标 URL 当 Chrome 启动参数 —— 启动期首次导航会和 CDP 握手抢时序，ws 会以 1006 断开。
 *      一律 about:blank 启动 + Page.navigate
 *   ③ 必须加 --no-sandbox —— 外层沙箱里 Chrome 自己的 zygote 会初始化失败，命令全部超时
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9333);
const MERMAID_RE = /<div class="mermaid">\n([\s\S]*?)\n\s*<\/div>/g;

const target = process.argv[2];
if (!target) {
  console.error('用法: node scripts/prerender-mermaid.mjs <html文件>');
  process.exit(1);
}
const targetPath = path.resolve(target);
if (!fs.existsSync(targetPath)) {
  console.error(`文件不存在: ${targetPath}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
  });
}

/** 极简 CDP 客户端：直接走 Node 22+ 自带的全局 WebSocket，不需要 playwright/puppeteer */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值并返回 JSON 结果（awaitPromise 让页面内的异步也能拿到） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate 抛错');
    return r.result?.value;
  }
}

// ── 1. 抽源码 ───────────────────────────────────────────────────────
const html = fs.readFileSync(targetPath, 'utf8');
const sources = [...html.matchAll(MERMAID_RE)].map((m) => m[1]);
if (sources.length === 0) {
  console.log('没有找到 <div class="mermaid"> 块，无需处理。');
  process.exit(0);
}
console.log(`找到 ${sources.length} 个 mermaid 块`);

// ── 2. 生成临时渲染页（必须与正式文档同目录，否则 ./_shared/ 相对路径失效）──
const dir = path.dirname(targetPath);
const prePath = path.join(dir, '_prerender.html');
const mermaidJs = path.join(dir, '_shared', 'js', 'mermaid.min.js');
if (!fs.existsSync(mermaidJs)) {
  console.error(`缺少 ${path.relative(REPO_ROOT, mermaidJs)}，请先从其它文档的 _shared 复制过来`);
  process.exit(1);
}
fs.writeFileSync(prePath, html.replace(
  '</body>',
  '<script src="./_shared/js/mermaid.min.js"></script>\n'
  + '<script>mermaid.initialize({startOnLoad:true,securityLevel:"loose"});</script>\n</body>',
));

let chrome;
let ws;
try {
  // ── 3. 起 Chrome（about:blank，不能带目标 URL）────────────────────
  chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + path.join('/tmp', `cdp-mermaid-${Date.now()}`),
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 20000;
  let version = null;
  while (Date.now() < deadline) {
    try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error(`Chrome 未在 20s 内就绪（端口 ${PORT}）`);
  console.log(`Chrome 就绪：${version.Browser}`);

  // 用现成的 about:blank page target（比 /json/new 稳）
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到可用的 page target');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const fileUrl = 'file://' + prePath;
  await cdp.send('Page.navigate', { url: fileUrl });
  console.log(`已导航到 ${path.basename(prePath)}，等待渲染…`);

  // ── 4. 轮询到图渲染完 ────────────────────────────────────────────
  let svgs = [];
  const renderDeadline = Date.now() + 30000;
  while (Date.now() < renderDeadline) {
    const state = await cdp.eval(`(() => {
      const blocks = [...document.querySelectorAll('.mermaid')];
      const ready = blocks.map(b => {
        const s = b.querySelector('svg');
        return s ? s.outerHTML : null;
      });
      return JSON.stringify({ total: blocks.length, got: ready.filter(Boolean).length, svgs: ready });
    })()`);
    const parsed = JSON.parse(state);
    if (parsed.total > 0 && parsed.got === parsed.total) {
      svgs = parsed.svgs;
      break;
    }
    await sleep(400);
  }
  if (svgs.length !== sources.length) {
    throw new Error(`渲染未完成：期望 ${sources.length} 张图，实际拿到 ${svgs.filter(Boolean).length} 张`);
  }

  // ★ 必须显式查 error 框：error SVG 也有尺寸、也不含源码原文，
  //   只查「宽高 > 0 + 无源码原文」会假通过
  const errors = svgs.filter((s) => /aria-roledescription="error"/.test(s)).length;
  if (errors > 0) {
    console.error(`✖ 有 ${errors} 张图渲染成 error 框（多半是 mermaid 语法错误）`);
    process.exit(1);
  }

  // ── 5. 回写（计数回调，源码与 SVG 按索引配对）─────────────────────
  let i = 0;
  const out = html.replace(MERMAID_RE, () =>
    `<script type="text/plain" class="mermaid-source" hidden>\n${sources[i]}\n</script>\n${svgs[i++]}`);
  fs.writeFileSync(targetPath, out);

  console.log(`✔ 已内联 ${svgs.length} 张静态 SVG → ${path.relative(REPO_ROOT, targetPath)}`);
  console.log(`  文件大小：${(fs.statSync(targetPath).size / 1024).toFixed(1)} KB`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(prePath, { force: true }); } catch { /* ignore */ }
}
