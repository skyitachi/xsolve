#!/usr/bin/env node
// 验证某个 origin 下 Service Worker 是否真的能注册 —— 「局域网 PWA 到底生效没有」的
// 唯一可靠答案。不用手点 DevTools，无头 Chrome + CDP 直接问浏览器三件事：
//   1. 这个 origin 是不是安全上下文（isSecureContext）
//   2. navigator.serviceWorker 存不存在（明文 HTTP + 非 localhost 时它是 undefined）
//   3. 显式注册 /sw.js 能不能成功、外壳缓存有没有真的写入
//
// 用法：
//   node scripts/check-sw.mjs https://192.168.0.112:8443/
//   node scripts/check-sw.mjs https://192.168.0.112:8443/ "$SPKI"   # 未装 CA 时用 SPKI 白名单模拟已信任
//
// 关于 SPKI（不想动系统钥匙串时用它）：
//   --ignore-certificate-errors-spki-list=<base64(sha256(DER 公钥))>
//   注意 **每次刷新服务器证书都会换密钥，SPKI 随之改变**，要重新算：
//     echo | openssl s_client -connect <host>:<port> -servername <host> 2>/dev/null \
//       | openssl x509 -outform PEM > /tmp/c.pem
//     openssl x509 -in /tmp/c.pem -pubkey -noout \
//       | openssl pkey -pubin -outform der \
//       | openssl dgst -sha256 -binary | openssl enc -base64
//
// 环境变量：CHROME_PATH 指定浏览器；SW_PORT 指定调试端口（默认 9355）；SW_DEBUG=1 打印原始 CDP 报文。
//
// 踩过的三个坑（都会表现为「Page.enable 超时」，很误导）：
//   1. 不要用 /json/new 建标签页 —— 拿到的 target 发 CDP 命令不响应。
//   2. 不要把目标 URL 直接作为 Chrome 的启动参数 —— 启动期的首次导航会和 CDP 握手
//      抢时序，ws 会在 open 之后立刻以 1006 被断开。一律 about:blank 启动 + Page.navigate。
//   3. 在外层沙箱里跑时要加 --no-sandbox —— 否则 Chrome 自己的 zygote 沙箱初始化失败
//      （GPU 进程 FATAL 退出），CDP 照样连得上但命令全部超时。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2];
const spki = process.argv[3] || '';
if (!url) {
  console.error('用法: node scripts/check-sw.mjs <url> [spkiBase64]');
  process.exit(2);
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  return candidates.find((p) => fs.existsSync(p)) || 'google-chrome';
}
const CHROME = findChrome();
const PORT = Number(process.env.SW_PORT || 9355);
const DEBUG = process.env.SW_DEBUG === '1';
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swchk-'));

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-proxy-server',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
];
if (spki) args.push(`--ignore-certificate-errors-spki-list=${spki}`);
args.push('about:blank'); // 导航交给我们自己控制，见文件头坑 #2

const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EVAL = `(async () => {
  const out = {
    href: location.href,
    isSecureContext: window.isSecureContext,
    hasServiceWorker: ('serviceWorker' in navigator),
  };
  if (!('serviceWorker' in navigator)) { out.register = 'SKIPPED(无 serviceWorker)'; return out; }
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时')), ms)),
  ]);
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    out.register = 'OK';
    out.scope = reg.scope;
    const ready = await withTimeout(navigator.serviceWorker.ready, 10000, 'ready');
    out.state = ready.active ? ready.active.state : null;
    out.scriptURL = ready.active ? ready.active.scriptURL : null;
    const keys = await caches.keys();
    out.cacheKeys = keys;
    let total = 0;
    for (const k of keys) { const c = await caches.open(k); total += (await c.keys()).length; }
    out.cachedCount = total;
  } catch (e) {
    out.register = 'ERROR: ' + (e && e.message ? e.message : String(e));
  }
  return out;
})()`;

let ws;
try {
  // 1) 等调试端口
  let ver = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!ver) throw new Error(`Chrome 调试端口未就绪（${CHROME}）\n` + chromeErr.slice(-600));
  console.log('[chrome] ' + ver.Browser);

  // 2) 找 about:blank 的 page target
  let tab = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    tab = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (tab) break;
    await sleep(250);
  }
  if (!tab) throw new Error('未找到 page target');

  // 3) 连 ws，建命令/事件管线
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  ws.onclose = () => { if (DEBUG) console.log('[ws close]'); };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });

  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (DEBUG && msg.method) console.log('[evt]', msg.method);
    if (msg.method) { events.push(msg.method); return; }
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); }
    }, timeoutMs);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 4) 自己导航并等 load（页面内脚本可能还会再重定向一次，之后多留一点时间）
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (events.includes('Page.loadEventFired')) break;
    await sleep(200);
  }
  await sleep(1200);

  // 5) 问浏览器
  const r = await send('Runtime.evaluate', {
    expression: EVAL,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    console.log('评估异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  }
  console.log(JSON.stringify(r.result && r.result.value ? r.result.value : r, null, 2));
} catch (e) {
  console.error('失败: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  chrome.kill('SIGKILL');
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
