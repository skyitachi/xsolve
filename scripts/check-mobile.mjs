#!/usr/bin/env node
// 移动端体验回归检查 —— 把「手机上到底能不能好好拍题/写题」变成一组可复跑的断言。
//
// 为什么需要它：这些问题的共同特征是**在桌面上完全看不出来**。
// 比如工具栏把「拍题」裁到屏幕外、切一次 Tab 手写内容就没了 —— 桌面浏览器窗口够宽、
// 也不会去切移动端的 Tab，所以只有真机或移动视口模拟才会暴露。
//
// 用法：
//   node scripts/check-mobile.mjs                       # 用 frontend/ 起一个本地预览
//   node scripts/check-mobile.mjs --w 360 --h 780       # 换机型的视口尺寸
//   node scripts/check-mobile.mjs --shot /tmp/m.png     # 顺便存一张截图
//   node scripts/check-mobile.mjs --keep                # 保留浏览器 profile 以便排查
//
// 它自己起一个内存 HTTP 服务并给 index.html 打桩（绕过登录与后端），
// 所以**不需要 NAS 在线、不需要装 CA、不依赖任何运行中的服务**。
//
// 环境变量：CHROME_PATH 指定浏览器；MOBILE_PORT 指定静态服务端口（默认 8923）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
}
const has = (name) => process.argv.includes('--' + name);

const DIR = path.resolve(arg('dir', path.join(REPO, 'frontend')));
const W = Number(arg('w', 390));
const H = Number(arg('h', 844));
const DPR = Number(arg('dpr', 3));
const SHOT = arg('shot', '');
const PORT = Number(process.env.MOBILE_PORT || 8923);
const CHROME =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome，可用 CHROME_PATH 指定');
  process.exit(2);
}

// ---- 给 index.html 打桩：去掉 auth.js，替换 window.XsolveAuth 与 fetch ----
const STUB = `  <script>
  window.XsolveAuth = {
    ready: Promise.resolve({ id: 1, username: 'preview', role: 'student', is_admin: 1 }),
    api: async () => ({}), guard: async () => true, logout: async () => {},
    applyRoleUI: () => {}, viewStudentId: () => 'me',
  };
  const PROBLEM = { id: 1, topic: '鸡兔同笼', text: '笼子里有若干只鸡和兔，共有头 30 个、脚 84 只。鸡和兔各有多少只？', hints: ['假设全是鸡，脚会少多少只？'] };
  const _f = window.fetch.bind(window);
  window.fetch = async (u, o) => {
    const url = typeof u === 'string' ? u : (u && u.url) || '';
    const j = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/problems')) return j([PROBLEM]);
    if (url.includes('/history')) return j([]);
    if (url.includes('/api/')) return j({ id: 's1', mode: 'student' });
    return _f(u, o);
  };
  </script>`;

let stubOk = true;
function readIndex() {
  let html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const anchor = '  <script src="js/auth.js"></script>';
  if (!html.includes(anchor)) {
    stubOk = false;
    return html;
  }
  return html.replace(anchor, STUB);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(readIndex());
    return;
  }
  const file = path.join(DIR, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---- 页内断言 ----
const PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};

  // ---- 1) 视口声明 ----
  const vp = document.querySelector('meta[name=viewport]');
  out.viewport = vp ? vp.getAttribute('content') : null;
  out.pinchZoomAllowed = !!vp && !/user-scalable\\s*=\\s*no/.test(out.viewport || '');
  out.keyboardResizesContent = !!vp && /interactive-widget\\s*=\\s*resizes-content/.test(out.viewport || '');

  // ---- 2) 上传入口：拍照 / 相册 必须各 2 个 ----
  const inputs = [...document.querySelectorAll('input[type=file]')].map(i => ({
    id: i.id, capture: i.getAttribute('capture'), accept: i.getAttribute('accept'),
  }));
  out.fileInputs = inputs;
  out.cameraInputs = inputs.filter(i => i.capture).length;
  out.albumInputs = inputs.filter(i => !i.capture).length;

  // ---- 3) 工具栏：切到「做题」Tab 后量溢出 ----
  document.querySelector('.mobile-tab[data-tab="work"]')?.click();
  await sleep(500);
  const wt = document.querySelector('.work-tools');
  if (wt) {
    const r = wt.getBoundingClientRect();
    const cs = getComputedStyle(wt);
    const kids = [...wt.children].filter(el => el.offsetParent !== null || el.className.includes('tool'));
    out.toolbar = {
      scrollable: wt.scrollWidth > wt.clientWidth + 1,
      scrollWidth: wt.scrollWidth, clientWidth: wt.clientWidth,
      wrap: cs.flexWrap, overflowX: cs.overflowX,
      items: kids.map(el => {
        const b = el.getBoundingClientRect();
        const label = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 12);
        return { label, left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width) };
      }),
    };
    // 「拍题」这个入口必须**无需横滑**就完整落在可视区内
    const cam = out.toolbar.items.find((i) => i.label.includes('拍题'));
    out.cameraTool = cam || null;
    out.cameraToolFullyVisible = !!cam && cam.left >= r.left - 1 && cam.right <= r.right + 1;
    out.overflowing = out.toolbar.items.filter(i => i.right > r.right + 1).map(i => i.label);
  }

  // ---- 4) 手写内容在「切 Tab」后是否还在 ----
  const sc = document.querySelector('#scratch');
  const inkOn = (cv) => {
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
    return n;
  };
  if (sc) {
    out.canvasApi = {
      redrawScratch: typeof redrawScratch === 'function',
      undoScratch: typeof undoScratch === 'function',
    };
    state.scratchStrokes.push({ t: 'pen', p: [{ x: 40, y: 40 }, { x: 160, y: 120 }, { x: 240, y: 60 }] });
    state.scratchStrokes.push({ t: 'pen', p: [{ x: 60, y: 200 }, { x: 300, y: 260 }] });
    if (out.canvasApi.redrawScratch) {
      redrawScratch();
    } else {
      // 旧版本只有 [点...] 这种裸数组、且没有重绘能力。这里手动画上去，
      // 好让「切 Tab 之后还在不在」这一项在新旧之间仍可对照。
      const c = sc.getContext('2d');
      c.strokeStyle = '#1f2937';
      c.lineWidth = 2.6;
      c.beginPath();
      state.scratchStrokes.forEach((s) => {
        const p = s.p || s;
        c.moveTo(p[0].x, p[0].y);
        p.slice(1).forEach((pt) => c.lineTo(pt.x, pt.y));
      });
      c.stroke();
    }
    out.inkBefore = inkOn(sc);
    out.canvasSizeBefore = [sc.width, sc.height];

    // 切到「题目」再切回「做题」—— 真机上这一步原来会把画面清空
    document.querySelector('.mobile-tab[data-tab="problem"]')?.click();
    await sleep(120);
    document.querySelector('.mobile-tab[data-tab="work"]')?.click();
    await sleep(400);
    out.inkAfterTabSwitch = inkOn(sc);
    out.canvasSizeAfter = [sc.width, sc.height];
    out.inkSurvivesTabSwitch = out.inkBefore > 0 && out.inkAfterTabSwitch >= out.inkBefore * 0.95;

    // 撤销一笔
    if (typeof undoScratch === 'function') {
      const n0 = state.scratchStrokes.length;
      undoScratch();
      await sleep(60);
      out.undoWorks = state.scratchStrokes.length === n0 - 1;
    } else {
      out.undoWorks = false; // 旧版本没有撤销
    }

    // ---- 5) 在 AI Tab（「做题」面板 display:none）导出草稿，不能是空图 ----
    document.querySelector('.mobile-tab[data-tab="ai"]')?.click();
    await sleep(300);
    const hidden = getComputedStyle(document.querySelector('.panel-work')).display === 'none';
    out.exportWhilePanelHidden = hidden;
    let du = null;
    try {
      du = exportScratchImage();
    } catch (e) {
      out.exportThrew = String((e && e.message) || e);
    }
    out.exportReturnedData = !!du && du.length > 200;
    out.exportHasInk = false;
    if (out.exportReturnedData) {
      try {
        const im = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error('导出的 dataURL 无法解码（多半是 0×0 的空图）'));
          i.src = du;
        });
        const cv = document.createElement('canvas');
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(im, 0, 0);
        const d = cx.getImageData(0, 0, cv.width, cv.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 200) dark++;
        out.exportSize = [cv.width, cv.height];
        out.exportDarkPixels = dark;
        out.exportHasInk = dark > 100;
      } catch (e) {
        out.exportLoadError = String((e && e.message) || e);
      }
    }
    document.querySelector('.mobile-tab[data-tab="work"]')?.click();
    await sleep(300);
  }

  // ---- 6) 裁剪模块可用 ----
  out.cropModule = typeof openCropDialog === 'function' && typeof dataUrlToParts === 'function';
  if (out.cropModule) {
    const t = document.createElement('canvas');
    t.width = 900; t.height = 700;
    const tc = t.getContext('2d');
    tc.fillStyle = '#fff'; tc.fillRect(0, 0, 900, 700);
    tc.fillStyle = '#000'; tc.font = '60px sans-serif'; tc.fillText('987 x 654', 120, 380);
    const p = openCropDialog(t.toDataURL('image/jpeg', 0.9));
    await sleep(400);
    const root = document.querySelector('.crop-root');
    out.cropOverlayShown = !!root;
    out.cropDefaultBoxInset = !!root; // 默认框是内缩的（能看到可拖的边）
    if (root) {
      // 框外必须压暗，否则用户看不出到底框住了哪一块
      const cc = root.querySelector('canvas');
      const c2 = cc.getContext('2d');
      const dpr2 = window.devicePixelRatio || 1;
      const lum = (x, y) => {
        const d = c2.getImageData(Math.round(x * dpr2), Math.round(y * dpr2), 1, 1).data;
        return Math.round(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
      };
      const cw = cc.width / dpr2;
      const ch = cc.height / dpr2;
      out.cropMask = {
        outside: lum(4, 4),
        inside: lum(cw / 2, ch / 2),
        canvasCss: [Math.round(cw), Math.round(ch)],
      };
      out.cropMaskWorks = out.cropMask.outside < out.cropMask.inside - 30;

      root.querySelector('[data-act="all"]').click();
      const res = await p;
      out.cropAllReturnsImage = !!res && res.startsWith('data:image/jpeg');
      const parts = dataUrlToParts(res || 'data:image/jpeg;base64,AA==');
      out.cropParts = { mediaType: parts.mediaType, base64Len: parts.base64.length };
      out.cropOverlayRemoved = !document.querySelector('.crop-root');
    }
  }
  return out;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

let ws;
let userDataDir;
try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const url = `http://127.0.0.1:${PORT}/index.html`;
  console.log(`[preview] ${url}  (${DIR})`);
  if (!stubOk) console.log('[warn] index.html 里没找到 <script src="js/auth.js">，桩未注入');

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobchk-'));
  const dbgPort = PORT + 100;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars',
    `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
    await sleep(250);
  }
  if (!ver) throw new Error('Chrome 调试端口未就绪\n' + chromeErr.slice(-500));

  let tab = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    tab = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (tab) break;
    await sleep(250);
  }
  if (!tab) throw new Error('未找到 page target');

  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 失败')); });
  let seq = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method) { events.push(m.method); return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  const send = (method, params = {}, t = 40000) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, t);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: DPR, mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (events.includes('Page.loadEventFired')) break; await sleep(200); }
  await sleep(1500);

  const r = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页内探测抛异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  const o = r.result.value;

  console.log(`[viewport] ${W}x${H} @${DPR}x\n`);

  check('允许双指缩放（数学小字要能放大）', o.pinchZoomAllowed, o.viewport);
  check('软键盘压缩布局而非遮挡', o.keyboardResizesContent, o.viewport);
  check('拍照入口 2 个（题目/解答）', o.cameraInputs === 2, JSON.stringify(o.fileInputs));
  check('相册入口 2 个（题目/解答，不带 capture）', o.albumInputs >= 2, JSON.stringify(o.fileInputs));

  if (o.toolbar) {
    console.log('[工具栏] ' + o.toolbar.items.map((i) => i.label).join(' | '));
    check('「拍题」入口无需横滑即完整可见', o.cameraToolFullyVisible, '拍题按钮: ' + JSON.stringify(o.cameraTool));
    check('工具栏为单行横滑（不再裁切）', o.toolbar.wrap === 'nowrap' && o.toolbar.overflowX === 'auto', `${o.toolbar.wrap} / ${o.toolbar.overflowX}`);
    check('溢出项均可横滑触及', o.toolbar.scrollable, `scrollWidth=${o.toolbar.scrollWidth} clientWidth=${o.toolbar.clientWidth}`);
  } else {
    check('工具栏目测', false, '未找到 .work-tools');
  }

  check('手写内容在切 Tab 后保留', o.inkSurvivesTabSwitch, `切前墨迹=${o.inkBefore} 切后=${o.inkAfterTabSwitch} 尺寸 ${o.canvasSizeBefore}→${o.canvasSizeAfter}`);
  check('撤销生效', o.undoWorks, `笔画数变化后墨迹=${o.inkAfterTabSwitch}`);
  check('在 AI Tab 导出草稿不空', o.exportHasInk, `面板隐藏=${o.exportWhilePanelHidden} 尺寸=${o.exportSize} 暗像素=${o.exportDarkPixels}`);
  check('裁剪模块可用且能返回图片', o.cropModule && o.cropOverlayShown && o.cropAllReturnsImage, JSON.stringify({ shown: o.cropOverlayShown, ret: o.cropAllReturnsImage, parts: o.cropParts, removed: o.cropOverlayRemoved }));
  check('裁剪框外已压暗（能看清框住哪块）', o.cropMaskWorks, JSON.stringify(o.cropMask));

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('已截图 → ' + SHOT);
  }

  console.log('');
  let bad = 0;
  for (const x of results) {
    if (!x.ok) bad++;
    console.log(`${x.ok ? '✔' : '✘'} ${x.name}${x.detail ? `  — ${x.detail}` : ''}`);
  }
  console.log(`\n${bad === 0 ? '全部通过' : bad + ' 项未通过'}（共 ${results.length} 项）`);
  if (bad) process.exitCode = 1;

  if (!has('keep')) chrome.kill('SIGKILL');
} catch (e) {
  console.error('失败: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch {}
  try { server.close(); } catch {}
  if (userDataDir && !has('keep')) {
    await sleep(200);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

// 显式退出。Chrome 会派生一堆子进程并继承 stdout/stderr 管道，
// 即使主进程已被 kill，管道读端仍可能等不到 EOF —— 表现为「脚本早就跑完了、
// 但外面这条命令永远不返回」。process.exit 直接结束，不等句柄自然释放。
process.exit(process.exitCode || 0);
