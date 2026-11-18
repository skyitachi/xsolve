#!/usr/bin/env node
// 桌面端 UI 样式探针 —— 验证 styles.css 的设计令牌与新视觉是否真正生效。
// 复用 check-mobile.mjs 的「静态服务 + auth 桩 + CDP」模式，但用桌面视口，
// 只读计算样式，不量移动端布局（那部分归 check-mobile.mjs 管）。
//
// 用法：node scripts/check-ui-style.mjs [--shot /tmp/xsolve-desktop.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIR = path.join(REPO, 'frontend');
const PORT = Number(process.env.UISTYLE_PORT || 8931);
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
})();
const DEMO = process.argv.includes('--demo');
const ARG = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};
const VW = ARG('w', 1440);
const VH = ARG('h', 900);
const SHOT_DARK = (() => {
  const i = process.argv.indexOf('--shot-dark');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
})();

const CHROME = process.env.CHROME_PATH ||
  (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 与 check-mobile.mjs 相同的 auth 桩 ----
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

function readIndex() {
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const anchor = '  <script src="js/auth.js"></script>';
  return html.includes(anchor) ? html.replace(anchor, STUB) : html;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail == null ? '' : String(detail) });
}

const PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  const cs = (el) => getComputedStyle(el);

  // 等页面把题目渲染出来（说明样式表已加载、JS 初始化完成）
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const pc = document.querySelector('#problem-content');
    if (pc && pc.textContent.trim().length > 0) break;
    await sleep(200);
  }

  const rootCS = getComputedStyle(document.documentElement);
  out.tokens = {
    accent: rootCS.getPropertyValue('--accent').trim(),
    surface: rootCS.getPropertyValue('--surface').trim(),
    line: rootCS.getPropertyValue('--line').trim(),
    rxl: rootCS.getPropertyValue('--r-xl').trim(),
    headerH: rootCS.getPropertyValue('--header-h').trim(),
  };
  out.isMobile = window.matchMedia('(max-width: 768px)').matches;
  out.iconSprite = document.querySelectorAll('svg symbol').length;
  out.iconUses = document.querySelectorAll('svg use').length;
  out.liveIcons = [...document.querySelectorAll('.topbar .ic')].filter(s => s.getBoundingClientRect().width > 6).length;
  out.cssSheets = [...document.styleSheets].length;

  const top = document.querySelector('.topbar');
  out.topbarGradient = top ? cs(top).backgroundImage.includes('linear-gradient') : false;
  out.topbarHeight = top ? cs(top).height : null;

  const layout = document.querySelector('.layout');
  out.layoutBorder = layout ? cs(layout).borderTopWidth + ' ' + cs(layout).borderTopColor : null;
  out.layoutRadius = layout ? cs(layout).borderTopLeftRadius : null;

  const panel = document.querySelector('.panel');
  out.panelShadow = panel ? cs(panel).boxShadow : null;

  const title = document.querySelector('.panel-title');
  out.titleGradient = title ? cs(title).backgroundImage.includes('linear-gradient') : false;

  const tool = document.querySelector('.work-tools .tool');
  out.toolTransition = tool ? cs(tool).transitionDuration : null;

  const composer = document.querySelector('.composer');
  out.composerExists = !!composer;
  out.composerRadius = composer ? cs(composer).borderTopLeftRadius : null;

  // 造一对消息气泡，验证底色 / 尾角 / 入场动画
  const log = document.querySelector('.chat-log');
  if (log) {
    const mk = (cls) => {
      const d = document.createElement('div');
      d.className = 'msg ' + cls;
      d.textContent = cls === 'msg-user' ? '12 只鸡' : '我们设鸡为 x 只……';
      log.appendChild(d);
      return d;
    };
    const u = mk('msg-user'), a = mk('msg-ai');
    const ucs = cs(u), acs = cs(a);
    out.userBubble = {
      softBg: ucs.backgroundColor !== 'rgba(0, 0, 0, 0)' && !ucs.backgroundImage.includes('linear-gradient'),
      tail: ucs.borderBottomRightRadius,
      anim: ucs.animationName,
      bg: ucs.backgroundColor,
    };
    out.aiBubble = {
      flat: acs.backgroundColor === 'rgba(0, 0, 0, 0)' &&
            (acs.borderTopWidth === '0px' || acs.borderTopStyle === 'none') &&
            acs.boxShadow === 'none',
      tail: acs.borderBottomLeftRadius,
      anim: acs.animationName,
      bg: acs.backgroundColor,
      border: acs.borderTopWidth + ' ' + acs.borderTopStyle,
    };
    u.remove(); a.remove();
  }

  // 焦点环：focus-visible 不可编程触发，改为检查规则存在
  out.focusRingRule = [...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes('focus-visible')); }
    catch { return false; }
  });
  // 减少动效媒体查询存在
  out.reducedMotionRule = [...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => r.media && /prefers-reduced-motion/.test(r.media.mediaText)); }
    catch { return false; }
  });
  // 滚动条规则
  out.scrollbarRule = [...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => r.cssText && r.cssText.includes('::-webkit-scrollbar-thumb')); }
    catch { return false; }
  });
  return out;
})()`;

let chrome = null, ws = null;
const kill = () => { try { chrome?.kill('SIGKILL'); } catch {} };

try {
  await new Promise((res, rej) => server.once('error', rej).listen(PORT, '127.0.0.1', res));
  const url = `http://127.0.0.1:${PORT}/index.html`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uichk-'));
  const dbgPort = PORT + 100;
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
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
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 2, mobile: VW <= 768 });
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (events.includes('Page.loadEventFired')) break; await sleep(200); }
  await sleep(1500);

  // --demo：塞一段「系统提示 + 学生提问 + AI 回答（含表格/公式/列表）」，用于目视气泡与长文排版
  if (DEMO) {
    await send('Runtime.evaluate', {
      expression: `(() => {
        const log = document.querySelector('.chat-log');
        if (!log) return 'no log';
        log.innerHTML = '';
        const add = (cls, html) => {
          const d = document.createElement('div');
          d.className = 'msg ' + cls;
          d.innerHTML = html;
          log.appendChild(d);
        };
        add('msg-system', '已恢复上次对话（session 保留中）。');
        add('msg-user', '<span>这题我设鸡有 x 只，兔子就是 30 - x 只，然后脚的数量是 2x + 4(30 - x) = 84，可是解出来是负数，哪里错了？</span>');
        add('msg-ai', '<p>你的列式完全正确，问题出在<b>解方程的那一步</b>：</p><p>$$2x + 4(30-x) = 84 \\Rightarrow 120 - 2x = 84 \\Rightarrow x = 18$$</p><ul><li>鸡：18 只</li><li>兔：12 只</li></ul><blockquote>小技巧：先假设全是鸡，脚会比实际少 24 只，每换一只兔子多 2 只脚。</blockquote><table><thead><tr><th>动物</th><th>数量</th><th>脚数</th></tr></thead><tbody><tr><td>鸡</td><td>18</td><td>36</td></tr><tr><td>兔</td><td>12</td><td>48</td></tr></tbody></table>');
        return 'ok';
      })()`,
      returnByValue: true,
    });
    await sleep(600);
  }

  const r = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页内探测抛异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  const o = r.result.value;

  // 深色模式：切到 prefers-color-scheme: dark，读同一批令牌，确认确实换了主题
  const r2 = (async () => {
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    await sleep(350);
    const d = await send('Runtime.evaluate', {
      expression: `(() => {
        const cs = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        const panel = document.querySelector('.panel');
        return {
          accent: cs.getPropertyValue('--accent').trim(),
          surface: cs.getPropertyValue('--surface').trim(),
          bp: cs.getPropertyValue('--bg').trim(),
          bodyBg: body.backgroundColor,
          panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
        };
      })()`,
      returnByValue: true,
    });
    if (SHOT_DARK) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(SHOT_DARK, Buffer.from(shot.data, 'base64'));
      console.log('已截图（深色）→ ' + SHOT_DARK);
    }
    await send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(250);
    return d.result.value;
  })();
  o.darkTokens = await r2;

  check('设计令牌 --accent 已定义', o.tokens.accent === '#4f46e5', `--accent=${o.tokens.accent}`);
  const wantHeader = o.isMobile ? '48px' : '56px';
  check(`设计令牌 --header-h = ${wantHeader}`, o.tokens.headerH === wantHeader, o.tokens.headerH);
  check('样式表已加载（≥2 份：KaTeX + 主样式）', o.cssSheets >= 2, `sheets=${o.cssSheets}`);
  check('SVG 图标雪碧图已就位（≥20 个 symbol）', o.iconSprite >= 20, `symbols=${o.iconSprite}`);
  check('页面用 <use> 引用图标（≥12 处）', o.iconUses >= 12, `uses=${o.iconUses}`);
  check('顶栏图标真实渲染（非 0 宽）', o.liveIcons >= 6, `icons=${o.liveIcons}`);
  check('顶栏改为中性底色（不再大面积渐变）', o.topbarGradient === false, `gradient=${o.topbarGradient}`);
  check(`顶栏高度 = ${wantHeader}（布局计算一致）`, o.topbarHeight === wantHeader, o.topbarHeight);
  if (o.isMobile) {
    check('移动端工作区全屏（无描边/圆角）',
      o.layoutBorder.startsWith('0px') && (o.layoutRadius === '0px' || o.layoutRadius === '0px 0px'),
      `border=${o.layoutBorder} radius=${o.layoutRadius}`);
  } else {
    check('工作区容器有发丝描边', !!o.layoutBorder && !o.layoutBorder.startsWith('0px'), o.layoutBorder);
    check('工作区容器大圆角', o.layoutRadius === '16px', o.layoutRadius);
  }
  check('面板本身无重阴影（靠 hairline 分区）', o.panelShadow === 'none', o.panelShadow);
  check('面板标题不再是渐变底', o.titleGradient === false, String(o.titleGradient));
  check('工具按钮有过渡动效', !!o.toolTransition && o.toolTransition !== '0s', `duration=${o.toolTransition}`);
  check('用户气泡为主色淡底 + 尾角 5px', o.userBubble.tail === '5px' && o.userBubble.softBg,
    JSON.stringify(o.userBubble));
  check('AI 消息去气泡化（无背景/无描边）', o.aiBubble.flat === true, JSON.stringify(o.aiBubble));
  check('消息入场动画（msg-in）', o.userBubble.anim === 'msg-in' && o.aiBubble.anim === 'msg-in',
    `${o.userBubble.anim}/${o.aiBubble.anim}`);
  check('composer 一体化输入框存在', o.composerExists === true, `radius=${o.composerRadius}`);
  check('深色模式令牌完整（accent/surface 均变）', o.darkTokens !== null &&
    o.darkTokens.accent !== o.tokens.accent, JSON.stringify(o.darkTokens));
  check('focus-visible 焦点环规则存在', o.focusRingRule === true);
  check('prefers-reduced-motion 降级规则存在', o.reducedMotionRule === true);
  check('细滚动条规则存在', o.scrollbarRule === true);

  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('已截图 → ' + SHOT);
  }

  let bad = 0;
  for (const x of results) {
    if (!x.ok) bad++;
    console.log(`${x.ok ? '✔' : '✘'} ${x.name}${x.detail ? `  — ${x.detail}` : ''}`);
  }
  console.log(`\n${bad === 0 ? '全部通过' : bad + ' 项未通过'}（共 ${results.length} 项）`);
  if (bad) process.exitCode = 1;
} catch (e) {
  console.error('失败: ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { server.close(); } catch {}
  kill();
  process.exit(process.exitCode || 0);
}
