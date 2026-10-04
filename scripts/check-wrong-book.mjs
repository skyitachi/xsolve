#!/usr/bin/env node
// 错题本页面的端到端回归检查。
//
// 为什么要这个：后端接口全绿 ≠ 页面对。这一层专门抓「接口对了但页面没接上」的问题——
// 元素 id 写错、字段名对不上、弹层打不开、按钮被挤出屏幕（移动端的老毛病）。
//
// 全程自包含，不需要 NAS / CA / 手动起服务：
//   临时 SQLite + 临时端口起真后端 → 无头 Chrome 用 390×844（手机视口）登录并操作页面 → 断言 DOM。
//
// 用法：node scripts/check-wrong-book.mjs
//
// 踩坑提示（与 check-sw.mjs 同源，别再重复）：Chrome 必须 about:blank 启动再 Page.navigate；
// 必须 --no-sandbox（沙箱里 zygote 会初始化失败，表现为 CDP 命令全部超时）；
// 页面内异步逻辑要用 Runtime.evaluate + awaitPromise，--dump-dom 会抓得太早。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const DB = path.join(os.tmpdir(), `_wbpage_${Date.now()}.db`);
const PORT = Number(process.env.WB_PORT || 8797);
const CDP_PORT = Number(process.env.WB_CDP_PORT || 9361);
const BASE = `http://localhost:${PORT}`;

// 父进程也要设，否则下面 import('../backend/db.js') 会打开现网库
process.env.DB_PATH = DB;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✘ ${name}   ${extra}`); }
}

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

const CHROME = findChrome();
const cleanupFns = [];
function cleanup() { while (cleanupFns.length) { try { cleanupFns.pop()(); } catch {} } }

(async () => {
  // ---------- 1. 起后端 ----------
  const server = spawn(NODE, ['backend/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, DB_PATH: DB, PORT: String(PORT), SKIP_STARTUP_CHECK: '1',
      CLAUDE_API_KEY: '', ANTHROPIC_API_KEY: '', API_KEY: '', VISION_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  cleanupFns.push(() => { try { server.kill('SIGTERM'); } catch {} });
  cleanupFns.push(() => setTimeout(() => { try { server.kill('SIGKILL'); } catch {} }, 900));

  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) { up = true; break; } } catch {}
    await sleep(200);
  }
  if (!up) throw new Error('后端没起来\n' + serverLog.slice(-1500));

  // ---------- 2. 造数据：一条自动收录的错题 + 一条手动加入 ----------
  const db = await import('../backend/db.js');
  const demoSid = db.getDb().prepare("SELECT id FROM users WHERE username = 'demo'").get().id;
  const probs = db.getDb().prepare('SELECT id, topic FROM problems ORDER BY created_at LIMIT 3').all();

  db.recordAttempt({
    student_id: demoSid, session_id: 's_page', turn_id: 't_page',
    problem_id: probs[0].id, topic: probs[0].topic, user_answer: '42', correct: false,
  });
  db.addWrongItem(demoSid, { problemId: probs[1].id, source: 'manual' });
  // 考试要点：不能出现的字段
  const expectCount = 2;

  if (!CHROME) {
    console.error('未找到 Chrome，跳过页面检查（设 CHROME_PATH 指定）');
    process.exit(2);
  }

  // ---------- 3. 起 Chrome ----------
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbpage-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });
  cleanupFns.push(() => { try { chrome.kill('SIGKILL'); } catch {} });
  cleanupFns.push(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
    await sleep(250);
  }
  if (!ver) throw new Error('Chrome 调试端口未就绪\n' + chromeErr.slice(-600));
  console.log(`[chrome] ${ver.Browser}\n`);

  let tab = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    tab = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (tab) break;
    await sleep(250);
  }
  if (!tab) throw new Error('未找到 page target');

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  cleanupFns.push(() => { try { ws.close(); } catch {} });

  let seq = 0;
  const pending = new Map();
  const events = [];
  let consoleErrors = [];
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method) {
      events.push(msg.method);
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      return;
    }
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, timeoutMs);
  });

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  }
  async function navigate(url) {
    const before = events.length;
    await send('Page.navigate', { url });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (events.slice(before).includes('Page.loadEventFired')) break;
      await sleep(150);
    }
    await sleep(700);
  }

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  // ---------- 4. 登录（页面内 fetch，Cookie 自然落到浏览器）----------
  console.log('=== 1. 登录与加载 ===');
  await navigate(BASE + '/login.html');
  const loginRes = await evaluate(`(async () => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'demo123' }),
    });
    return { status: r.status, body: await r.text() };
  })()`);
  check('页面内登录成功', loginRes.status === 200, JSON.stringify(loginRes).slice(0, 200));

  // ---------- 5. 错题本页面 ----------
  await navigate(BASE + '/wrong-book.html');
  const page = await evaluate(`(async () => {
    // 等首屏数据到位（最多 8 秒）
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (document.querySelectorAll('#wb-books .book-chip').length) break;
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 400));
    const chips = [...document.querySelectorAll('#wb-books .book-chip')];
    const items = [...document.querySelectorAll('#wb-list .item')];
    const btn = document.querySelector('#wb-photo-btn');
    const r = btn.getBoundingClientRect();
    return {
      title: document.title,
      chipLabels: chips.map(c => c.textContent.trim()),
      stats: {
        due: document.querySelector('#st-due').textContent,
        mastered: document.querySelector('#st-mastered').textContent,
        total: document.querySelector('#st-total').textContent,
        line: document.querySelector('#st-line').textContent,
      },
      tabs: [...document.querySelectorAll('#wb-tabs .tab')]
        .map(t => ({ label: t.textContent.trim(), on: t.classList.contains('active') })),
      // 复习调度的可视化：等级点阵 / 下次复习文案 / 错因标签
      firstSched: items[0] ? {
        lvOn: items[0].querySelectorAll('.lvdot.on').length,
        lvAll: items[0].querySelectorAll('.lvdot').length,
        text: items[0].querySelector('.sched') ? items[0].querySelector('.sched').textContent : '',
        err: items[0].querySelector('.tag.err, .tag.err-none')
          ? items[0].querySelector('.tag.err, .tag.err-none').textContent : null,
      } : null,
      // 按「来源」而非「第几条」取样本：列表是按到期时间排序的，谁排第一会随排期变化，
      // 拿 items[0] 断言具体某个标签属于「测试床假设」，改排序就会假失败。
      bySrc: items.map((n) => ({
        src: [...n.querySelectorAll('.tag')].map(t => t.textContent).find(t => /做错了|手动加入|拍照录入/.test(t)) || '',
        err: n.querySelector('.tag.err, .tag.err-none')
          ? n.querySelector('.tag.err, .tag.err-none').textContent : null,
        lvOn: n.querySelectorAll('.lvdot.on').length,
        lvAll: n.querySelectorAll('.lvdot').length,
        sched: n.querySelector('.sched') ? n.querySelector('.sched').textContent : '',
      })),
      limitHidden: document.querySelector('#wb-limit').hidden,
      itemCount: items.length,
      firstItemText: items[0] ? items[0].querySelector('.txt').textContent : null,
      firstItemTags: items[0] ? [...items[0].querySelectorAll('.tag')].map(t => t.textContent) : [],
      photoBtn: { text: btn.textContent.trim(), right: Math.round(r.right), viewport: window.innerWidth },
      emptyHidden: document.querySelector('#wb-empty').hidden,
    };
  })()`);

  check('页面标题正确', /错题本/.test(page.title || ''), page.title);
  check('默认错题本以 chip 形式渲染', page.chipLabels.some((c) => c.includes('我的错题本')), JSON.stringify(page.chipLabels));
  check('「新建」入口存在', page.chipLabels.some((c) => c.includes('新建')), JSON.stringify(page.chipLabels));
  check(`统计显示今日待复习=${expectCount}（实际 ${page.stats.due}）`, page.stats.due === String(expectCount), JSON.stringify(page.stats));
  check(`列表渲染出 ${expectCount} 条错题（实际 ${page.itemCount}）`, page.itemCount === expectCount);
  check('空状态已隐藏', page.emptyHidden === true);
  check('条目显示题面文字', !!page.firstItemText && page.firstItemText.length > 2, String(page.firstItemText).slice(0, 40));
  check('条目带主题与来源标签', page.firstItemTags.length >= 2, JSON.stringify(page.firstItemTags));
  check('来源标签是中文而非原样英文', page.firstItemTags.some((t) => /做错了|手动加入|拍照录入/.test(t)), JSON.stringify(page.firstItemTags));

  // ---------- 复习调度的可视化（P1）----------
  const tabLabels = page.tabs.map((t) => t.label);
  check('三态 Tab 齐备（待复习 / 全部 / 已掌握）',
    tabLabels.length === 3 && /待复习/.test(tabLabels[0]) && /全部/.test(tabLabels[1]) && /已掌握/.test(tabLabels[2]),
    JSON.stringify(page.tabs));
  check('默认停在「待复习」（而不是「全部」）',
    page.tabs[0] && page.tabs[0].on === true && page.tabs[1].on === false, JSON.stringify(page.tabs));
  // 样本按「来源」定位，不假设谁排在第一条（列表按到期时间排序，排序变了也算通过）
  const autoItem = page.bySrc.find((i) => /做错了/.test(i.src)) || {};
  const manualItem = page.bySrc.find((i) => /手动加入/.test(i.src)) || {};
  check('卡片渲染记忆等级点阵', autoItem.lvAll === 4 && autoItem.lvOn === 0,
    JSON.stringify(autoItem));
  check('卡片显示复习排期文案', /今天该练|再练/.test(autoItem.sched || ''),
    JSON.stringify(autoItem.sched));
  check('手动加入的题（无错因）显示「未归因」占位', manualItem.err === '未归因',
    JSON.stringify(manualItem));
  // 规则兜底只对「数值 vs 数值 / 数值 vs 表达式」这类可判形态生效，文字答案会返回 null；
  // 本测试床答错的是 42（正确 84），属可判形态 → 必须带上错因标签。
  check('答错的题由规则兜底打上错因标签（本床：42 vs 84）',
    !!autoItem.err && autoItem.err !== '未归因', JSON.stringify(autoItem.err));
  check('每日上限提示条在未超限时隐藏', page.limitHidden === true);
  check(
    `「拍照录入」按钮在 390px 视口内（右边界 ${page.photoBtn.right}px）`,
    page.photoBtn.right <= page.photoBtn.viewport,
    `right=${page.photoBtn.right} viewport=${page.photoBtn.viewport}`,
  );

  // 题面里的 $...$ 必须被 KaTeX 渲染成公式，否则孩子看到的是 `$\frac{2}{5}$` 这种源码
  const math = await evaluate(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (document.querySelectorAll('#wb-list .katex').length) break;
      await new Promise(r => setTimeout(r, 150));
    }
    return {
      katexCount: document.querySelectorAll('#wb-list .katex').length,
      rawDollar: document.querySelector('#wb-list').textContent.includes('\\\\frac'),
      listText: document.querySelector('#wb-list').textContent.slice(0, 80),
      // 诊断字段：下次再遇到「列表没渲染公式」时不用只靠猜
      katexReady: typeof window.renderMathInElement === 'function',
      // 页面自报的渲染成败（静默失效时这是唯一线索）
      mathDiag: window.__wbMath || null,
      firstHtml: (document.querySelector('#wb-list .item .txt') || {}).innerHTML || null,
      firstItemId: (document.querySelector('#wb-list .item') || {}).getAttribute
        ? document.querySelector('#wb-list .item').getAttribute('data-item') : null,
    };
  })()`);
  check(`题面里的公式已渲染（找到 ${math.katexCount} 处 KaTeX）`, math.katexCount > 0, JSON.stringify(math));
  check('列表里不再残留 \\frac 源码', math.rawDollar === false, math.listText);

  // ---------- 6. 详情弹层 ----------
  console.log('\n=== 2. 详情弹层 ===');
  const detail = await evaluate(`(async () => {
    document.querySelector('#wb-list .item').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      if (!document.querySelector('#sheet-detail').hidden && document.querySelector('#dt-body').textContent.trim()) break;
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 500));
    const body = document.querySelector('#dt-body');
    return {
      open: !document.querySelector('#sheet-detail').hidden,
      text: body.textContent.trim().slice(0, 400),
      hasRedo: !!document.querySelector('#dt-redo'),
      hasMaster: !!document.querySelector('#dt-master'),
      hasImageTag: !!document.querySelector('#dt-img'),
      masterLabel: document.querySelector('#dt-master').textContent.trim(),
      // 错因标注区（P1）：枚举按钮 + 备注框。注意「清空」也是一个 .chip，
  // 所以断言要按 data-err 是否有值来区分，而不是数 .chip 总数。
      errChipCount: document.querySelectorAll('#dt-chips .chip[data-err]:not([data-err=""])').length,
      errChipTotal: document.querySelectorAll('#dt-chips .chip').length,
      hasNote: !!document.querySelector('#dt-note'),
      hasReviewList: !!document.querySelector('.rev-list'),
    };
  })()`);
  check('详情弹层打开', detail.open === true);
  check('详情显示完整题面', detail.text.length > 10, detail.text.slice(0, 60));
  check('详情显示「我上次写错的答案」= 42', detail.text.includes('42'), detail.text.slice(0, 200));
  check('详情有「重做」按钮', detail.hasRedo === true);
  check('详情有错因枚举（5+1 个可点按钮 + 清空）',
    detail.errChipCount === 6 && detail.errChipTotal === 7,
    JSON.stringify({ err: detail.errChipCount, all: detail.errChipTotal }));
  check('详情有「备注」输入框', detail.hasNote === true);
  check('详情解释了「重做 → 等级 → 毕业」的关系', /等级/.test(detail.text) && /已掌握/.test(detail.text),
    detail.text.slice(0, 160));

  // 错因标注要真的落库（点一下 → 后端 → 重新渲染后仍选中），不能只是前端变色
  const errSaved = await evaluate(`(async () => {
    const target = [...document.querySelectorAll('#dt-chips .chip')]
      .find(c => c.getAttribute('data-err') === '审题');
    if (!target) return { skip: true };
    target.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const on = document.querySelector('#dt-chips .chip.on');
      if (on && on.getAttribute('data-err') === '审题') break;
      await new Promise(r => setTimeout(r, 200));
    }
    const on = document.querySelector('#dt-chips .chip.on');
    const listErr = document.querySelector('#wb-list .item .tag.err');
    const srcNote = document.querySelector('#dt-body .sec-title');
    return {
      skip: false,
      on: on ? on.getAttribute('data-err') : null,
      listErr: listErr ? listErr.textContent : null,
      markedManual: srcNote ? /人工标注/.test(srcNote.textContent) : false,
      hasReviewList: !!document.querySelector('.rev-list'),
    };
  })()`);
  check('点错因标签落到后端并回显选中', errSaved.skip || errSaved.on === '审题', JSON.stringify(errSaved));
  check('列表卡片同步显示新错因', errSaved.skip || errSaved.listErr === '审题', JSON.stringify(errSaved));
  check('来源标记变为「人工标注」', errSaved.skip || errSaved.markedManual === true, JSON.stringify(errSaved));

  // Tab 切换：本测试床没有已掌握的题，正好验证「已掌握为空」的空态
  // 与「整个错题本为空」是两句不同的话（混成一句是常见的体验瑕疵）
  const tabSwitch = await evaluate(`(async () => {
    const closer = document.querySelector('[data-close="sheet-detail"]');
    if (closer) closer.click();
    const tabs = [...document.querySelectorAll('#wb-tabs .tab')];
    tabs[2].click();
    await new Promise(r => setTimeout(r, 900));
    const empty = document.querySelector('#wb-empty');
    const out = {
      active: [...document.querySelectorAll('#wb-tabs .tab')].findIndex(t => t.classList.contains('active')),
      emptyShown: empty ? !empty.hidden : false,
      emptyTitle: document.querySelector('#wb-empty-title').textContent,
      itemCount: document.querySelectorAll('#wb-list .item').length,
    };
    // 切回「待复习」，后面的用例依赖它
    tabs[0].click();
    await new Promise(r => setTimeout(r, 900));
    return out;
  })()`);
  check('切到「已掌握」Tab 生效且列表清空', tabSwitch.active === 2 && tabSwitch.itemCount === 0,
    JSON.stringify(tabSwitch));
  check('已掌握为空时是专属空态（区别于「错题本是空的」）',
    tabSwitch.emptyShown && /还没有已掌握/.test(tabSwitch.emptyTitle), JSON.stringify(tabSwitch));

  // ---------- 7. 从题库加题 ----------
  console.log('\n=== 3. 从题库加题 ===');
  const pick = await evaluate(`(async () => {
    document.querySelector('[data-close="sheet-detail"]').click();
    document.querySelector('#wb-pick-btn').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (document.querySelectorAll('#pk-list .pick-row').length) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const rows = [...document.querySelectorAll('#pk-list .pick-row')];
    return {
      sheetOpen: !document.querySelector('#sheet-pick').hidden,
      rowCount: rows.length,
      disabledCount: rows.filter(r => r.querySelector('input').disabled).length,
      firstText: rows[0] ? rows[0].querySelector('.t').textContent.slice(0, 50) : null,
    };
  })()`);
  check('题库弹层打开', pick.sheetOpen === true);
  check(`题库列出候选题（${pick.rowCount} 道）`, pick.rowCount > 0);
  check(`已在错题本里的题被禁用勾选（${pick.disabledCount} 道）`, pick.disabledCount === expectCount, `disabled=${pick.disabledCount}`);
  check('候选项显示题面', !!pick.firstText && pick.firstText.length > 2, String(pick.firstText));

  // 真的勾一道加入
  const added = await evaluate(`(async () => {
    const rows = [...document.querySelectorAll('#pk-list .pick-row')];
    const target = rows.find(r => !r.querySelector('input').disabled);
    if (!target) return { skip: true };
    target.querySelector('input').click();
    document.querySelector('#pk-add').click();
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if (document.querySelector('#sheet-pick').hidden) break;
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 700));
    return { skip: false, itemCount: document.querySelectorAll('#wb-list .item').length };
  })()`);
  check(`勾选后加入成功，列表增加到 ${expectCount + 1} 条`, added.skip || added.itemCount === expectCount + 1, JSON.stringify(added));

  // ---------- 8. 拍照录入的表单（不调真实视觉）----------
  console.log('\n=== 4. 拍照录入入口 ===');
  const photo = await evaluate(`(async () => {
    const cam = document.querySelector('#wb-photo-camera');
    const album = document.querySelector('#wb-photo-album');
    const btn = document.querySelector('#wb-photo-btn');
    return {
      hasCameraInput: !!cam, cameraCapture: cam ? cam.getAttribute('capture') : null,
      hasAlbumInput: !!album, albumCapture: album ? album.getAttribute('capture') : null,
      btnVisible: btn.getBoundingClientRect().height > 20,
      hasPhotoSheet: !!document.querySelector('#sheet-photo'),
      sheetFields: ['ph-topic','ph-text','ph-answer','ph-hints','ph-save'].every(id => !!document.getElementById(id)),
    };
  })()`);
  check('存在「拍照」input 且带 capture=environment', photo.hasCameraInput && photo.cameraCapture === 'environment', JSON.stringify(photo));
  check('存在「相册」input 且【不带】capture（否则选不了已有照片）', photo.hasAlbumInput && !photo.albumCapture, JSON.stringify(photo));
  check('「拍照录入」按钮可见', photo.btnVisible === true);
  check('确认表单字段齐全', photo.sheetFields === true);

  check('页面无 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  cleanup();
  await sleep(700);
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n检查失败：', e.message);
  cleanup();
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(1);
});
