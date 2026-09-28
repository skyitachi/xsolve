// 错题本后端端到端自测（临时库 + 临时端口，跑完自清）。
//
// 覆盖：鉴权分层、多本 CRUD、三种录入入口（手动/自动/拍照 commit）、
//       列表与详情的字段红线（不下发 answer / image_dataurl）、越权隔离、
//       以及视觉返回的容错解析。
//
// 跑法（必须用 system Node 26 —— better-sqlite3 按 ABI 147 编译）：
//   unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
//   /Users/skyitachi/.nvm/versions/node/v26.4.0/bin/node backend/scripts/wrong-book-api-selftest.mjs
//
// 页面层另有 scripts/check-wrong-book.mjs（无头 Chrome 真渲染，抓「接口对了但页面没接上」）。
// ⚠️ 本脚本不会调真实视觉模型：photo/parse 只测校验分支，识别质量要靠真图手测。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;
const DB = '/tmp/_wb_test.db';
const PORT = 8793;
const BASE = `http://localhost:${PORT}`;
process.env.DB_PATH = DB; // ★ 必须早于任何 import('../db.js')，否则父进程会开现网库

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✘ ${name}   ${extra}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function makeClient() {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  function absorb(resp) {
    const list = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie')].filter(Boolean);
    for (const c of list) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v) jar.delete(k); else jar.set(k, v);
    }
  }
  async function req(method, url, body) {
    const headers = {}; const ch = cookieHeader(); if (ch) headers.cookie = ch;
    let payload;
    if (body !== undefined && body !== null) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const resp = await fetch(BASE + url, { method, headers, body: payload });
    absorb(resp);
    const text = await resp.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    return { status: resp.status, data };
  }
  return {
    get: (u) => req('GET', u), post: (u, b) => req('POST', u, b),
    patch: (u, b) => req('PATCH', u, b), del: (u) => req('DELETE', u), req, jar,
  };
}

const child = spawn(NODE, ['backend/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env, DB_PATH: DB, PORT: String(PORT), SKIP_STARTUP_CHECK: '1',
    CLAUDE_API_KEY: '', ANTHROPIC_API_KEY: '', API_KEY: '', VISION_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => {
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1200);
};

(async () => {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  const anon = makeClient();
  const demo = makeClient();

  // ---------- 1. 鉴权 ----------
  section('1. 鉴权：未登录一律 401 且带 need_login');
  for (const [m, u] of [
    ['get', '/api/wrong-book/books'], ['post', '/api/wrong-book/books'],
    ['get', '/api/wrong-book/items'], ['post', '/api/wrong-book/items'],
    ['get', '/api/wrong-book/candidates'], ['post', '/api/wrong-book/photo/parse'],
    ['post', '/api/wrong-book/photo/commit'],
  ]) {
    const r = await anon[m](u, m === 'get' ? undefined : {});
    check(`${m.toUpperCase()} ${u} → 401`, r.status === 401 && r.data.need_login === true, `got ${r.status} ${JSON.stringify(r.data)}`);
  }

  // ---------- 2. 登录 + 本子 ----------
  section('2. 错题本 CRUD');
  const login = await demo.post('/api/auth/login', { username: 'demo', password: 'demo123' });
  check('demo 登录成功', login.status === 200, JSON.stringify(login.data));

  const books0 = await demo.get('/api/wrong-book/books');
  check('默认本自动创建', books0.status === 200 && books0.data.books.length === 1
    && books0.data.books[0].is_default === true, JSON.stringify(books0.data));
  check('默认本名字是「我的错题本」', books0.data.books[0]?.name === '我的错题本', books0.data.books[0]?.name);

  const newBook = await demo.post('/api/wrong-book/books', { name: '立体几何专练', emoji: '📐' });
  check('建新本', newBook.status === 200 && newBook.data.book.name === '立体几何专练', JSON.stringify(newBook.data));
  const bookId = newBook.data.book?.id;

  const dup = await demo.post('/api/wrong-book/books', { name: '立体几何专练' });
  check('同名本被拒 409', dup.status === 409, `got ${dup.status}`);

  const empty = await demo.post('/api/wrong-book/books', { name: '   ' });
  check('空名被拒 400', empty.status === 400, `got ${empty.status}`);

  const ren = await demo.patch(`/api/wrong-book/books/${bookId}`, { name: '几何专练' });
  check('重命名生效', ren.status === 200 && ren.data.book.name === '几何专练', JSON.stringify(ren.data));

  const delDefault = await demo.del(`/api/wrong-book/books/${books0.data.books[0].id}`);
  check('默认本不可删 400', delDefault.status === 400, `got ${delDefault.status}`);

  // ---------- 3. 手动加入（将现有题目加入错题本）----------
  section('3. 手动加入：从题库挑题');
  const cand = await demo.get('/api/wrong-book/candidates');
  const candList = cand.data.problems || [];
  check('候选题库非空', cand.status === 200 && candList.length >= 3, `n=${candList.length}`);
  check('候选不下发 answer', candList.every((p) => !('answer' in p)));
  check('候选不下发 figureImage（base64 大字段）', candList.every((p) => !('figureImage' in p)));
  check('候选带 in_book 标记', candList.every((p) => 'in_book' in p));
  check('候选初始都不在错题本里', candList.every((p) => p.in_book === false));

  const ids = candList.slice(0, 2).map((p) => p.id);
  const add1 = await demo.post('/api/wrong-book/items', { problemIds: ids });
  check('批量加入 2 道题', add1.status === 200 && add1.data.added === 2, JSON.stringify(add1.data));

  const add2 = await demo.post('/api/wrong-book/items', { problemIds: ids });
  check('重复加入不新增（already=2）', add2.data.added === 0 && add2.data.already === 2, JSON.stringify(add2.data));

  const addBad = await demo.post('/api/wrong-book/items', { problemId: 'no_such_problem' });
  check('不存在的题被跳过', addBad.data.added === 0 && addBad.data.skipped.length === 1, JSON.stringify(addBad.data));

  const addNoId = await demo.post('/api/wrong-book/items', {});
  check('缺 problemId → 400', addNoId.status === 400, `got ${addNoId.status}`);

  const cand2 = await demo.get('/api/wrong-book/candidates');
  check('已加入的题被标 in_book', cand2.data.problems.filter((p) => p.in_book).length === 2);

  // ---------- 4. 列表 / 详情 ----------
  section('4. 列表与详情');
  const list = await demo.get('/api/wrong-book/items');
  check('列表 2 条', list.data.items.length === 2, `n=${list.data.items.length}`);
  check('列表不下发 answer', list.data.items.every((it) => !('answer' in it)));
  check('列表不下发 image_dataurl', list.data.items.every((it) => !('image_dataurl' in it)));
  check('列表带 has_image 标记', list.data.items.every((it) => 'has_image' in it));
  check('列表题面被截断到 ≤91 字', list.data.items.every((it) => !it.text || it.text.length <= 91));
  check('列表条目带 source=manual', list.data.items.every((it) => it.source === 'manual'));

  const itemId = list.data.items[0].id;
  const detail = await demo.get(`/api/wrong-book/items/${itemId}`);
  check('详情返回完整题面', detail.status === 200 && !!detail.data.problem?.text, JSON.stringify(detail.data).slice(0, 200));
  check('详情不含 answer', detail.data.problem && !('answer' in detail.data.problem));
  check('详情不含 hints', detail.data.problem && !('hints' in detail.data.problem));
  check('详情给出「上次写错的答案」字段（此时为 null）', 'wrong_answer' in detail.data && detail.data.wrong_answer === null);

  const notFound = await demo.get('/api/wrong-book/items/no_such_item');
  check('不存在的条目 → 404', notFound.status === 404, `got ${notFound.status}`);

  // ---------- 5. 自动收录（直接走真实 recordAttempt）----------
  section('5. 自动收录：答错时进默认错题本');
  const dbMod = await import('../db.js');
  const demoSid = dbMod.getDb().prepare("SELECT id FROM users WHERE username = 'demo'").get().id;
  const p3 = candList[2].id;
  dbMod.recordAttempt({
    student_id: demoSid, session_id: 's_wb', turn_id: 't_wb', problem_id: p3,
    topic: 'auto', user_answer: 'WRONG', correct: false,
  });
  dbMod.recordAttempt({
    student_id: demoSid, session_id: 's_wb', turn_id: 't_wb', problem_id: p3,
    topic: 'auto', user_answer: 'WRONG', correct: false,
  });
  const list2 = await demo.get('/api/wrong-book/items');
  const autoItem = list2.data.items.find((it) => it.problem_id === p3);
  check('答错的题被自动收录', !!autoItem && autoItem.source === 'auto', JSON.stringify(list2.data.items.map((i) => i.source)));
  check('去重后 wrong_count=1（重复提交不刷高次数）', autoItem?.wrong_count === 1, `got ${autoItem?.wrong_count}`);

  const detailAuto = await demo.get(`/api/wrong-book/items/${autoItem.id}`);
  check('详情里能看到自己写错的答案', detailAuto.data.wrong_answer?.answer === 'WRONG', JSON.stringify(detailAuto.data.wrong_answer));

  // ---------- 6. 掌握 / 重做 ----------
  section('6. 标记已掌握与重做计数');
  const mastered = await demo.post(`/api/wrong-book/items/${itemId}/master`, { mastered: true });
  check('标记已掌握', mastered.status === 200 && mastered.data.item.status === 'mastered');
  const unmastered = await demo.post(`/api/wrong-book/items/${itemId}/master`, { mastered: false });
  check('取消掌握回到 pending', unmastered.data.item.status === 'pending');
  const review = await demo.post(`/api/wrong-book/items/${itemId}/review`, {});
  check('记一次重做 review_count=1', review.status === 200 && review.data.item.review_count === 1, JSON.stringify(review.data));

  // ---------- 7. 移动 / 删除 ----------
  section('7. 跨本移动与删除');
  const mv = await demo.post('/api/wrong-book/items', { problemIds: [ids[0]], bookId });
  check('指定 bookId 加入 → 移动而非新增', mv.data.added === 0 && mv.data.already === 1, JSON.stringify(mv.data));
  const inNewBook = await demo.get(`/api/wrong-book/items?bookId=${bookId}`);
  check('新本里有 1 条', inNewBook.data.items.length === 1, `n=${inNewBook.data.items.length}`);
  const total = await demo.get('/api/wrong-book/items');
  check('总数仍是 3（一题一条，移动不复制）', total.data.items.length === 3, `n=${total.data.items.length}`);

  const delBook = await demo.del(`/api/wrong-book/books/${bookId}`);
  check('删本：条目不删，回落到默认本', delBook.status === 200 && delBook.data.moved === 1, JSON.stringify(delBook.data));
  const afterDel = await demo.get('/api/wrong-book/items');
  check('删本后总数不变', afterDel.data.items.length === 3, `n=${afterDel.data.items.length}`);

  const rm = await demo.del(`/api/wrong-book/items/${itemId}`);
  check('删除条目', rm.status === 200);
  const afterRm = await demo.get('/api/wrong-book/items');
  check('删除后少 1 条', afterRm.data.items.length === 2, `n=${afterRm.data.items.length}`);

  // ---------- 8. 拍照录入 ----------
  section('8. 拍照解析录入');
  const badImg = await demo.post('/api/wrong-book/photo/parse', { image: 'not-an-image' });
  check('非图片 → 400', badImg.status === 400, `got ${badImg.status}`);

  const commit = await demo.post('/api/wrong-book/photo/commit', {
    draft: { topic: '圆锥体积', text: '圆锥底面半径 3，高 4，求体积', answer: '12π', hints: ['V=1/3Sh'], has_figure: false },
  });
  check('提交草稿 → 建题并直接入本', commit.status === 200 && commit.data.ok === true, JSON.stringify(commit.data).slice(0, 200));
  check('返回的题目不带 answer', commit.data.problem && !('answer' in commit.data.problem));
  check('新条目 source=photo', commit.data.item?.source === 'photo', commit.data.item?.source);
  check('拍照录入不计错误次数', commit.data.item?.wrong_count === 0, `got ${commit.data.item?.wrong_count}`);

  const listAfterPhoto = await demo.get('/api/wrong-book/items');
  check('错题本多了这道拍照题', listAfterPhoto.data.items.length === 3, `n=${listAfterPhoto.data.items.length}`);

  const noAnswer = await demo.post('/api/wrong-book/photo/commit', { draft: { text: '有题面没答案' } });
  check('缺答案 → 400（避免入库残缺题）', noAnswer.status === 400, `got ${noAnswer.status}`);
  const noText = await demo.post('/api/wrong-book/photo/commit', { draft: { answer: '1' } });
  check('缺题面 → 400', noText.status === 400, `got ${noText.status}`);

  const stats = (await demo.get('/api/wrong-book/books')).data.stats;
  check('统计口径：total=3 / pending=3 / by_source.photo=1', stats.total === 3 && stats.pending === 3 && stats.by_source.photo === 1, JSON.stringify(stats));

  // ---------- 9. 越权 ----------
  section('9. 越权与隔离');
  // demo 的 role 是 student → resolveTargetStudent 忽略传入的 studentId
  const peek = await demo.get('/api/wrong-book/items?studentId=someone_else');
  check('学生传 studentId 无法越权读别人的', peek.status === 200 && peek.data.items.length === 3, `n=${peek.data.items.length}`);

  const otherSid = 'other_stu_wb';
  dbMod.recordAttempt({
    student_id: otherSid, session_id: 's_other', turn_id: 't_other', problem_id: p3,
    topic: 'auto', user_answer: 'W', correct: false,
  });
  const otherList = dbMod.listWrongItems(otherSid);
  // 隔离的正确断言：对方只看得见自己那 1 条，看不到 demo 手动加的 2 条
  check('另一个学生的错题本互相隔离',
    otherList.length === 1 && otherList[0].problem_id === p3 && otherList.every((it) => it.source !== 'manual'),
    JSON.stringify(otherList.map((i) => [i.problem_id, i.source])));
  check('条目不下发 student_id（归属由服务端决定，前端不需要）',
    !('student_id' in otherList[0]));
  const stillMine = await demo.get('/api/wrong-book/items');
  check('别人的收录不影响我的列表', stillMine.data.items.length === 3, `n=${stillMine.data.items.length}`);
  check('删不动别人的条目', dbMod.removeWrongItem(otherList[0].id, demoSid) === false);

  // ---------- 9.5 题目被删除之后 ----------
  // 放在最后：这一步会改掉题目总数，跑在前面的计数断言会跟着变
  section('9.5 题目被删除后，错题记录不能跟着消失');
  const delPid = candList[3].id;
  await demo.post('/api/wrong-book/items', { problemIds: [delPid] });
  const delProb = await demo.del(`/api/problem/${encodeURIComponent(delPid)}`);
  check('题目删除接口返回成功（demo 是管理员）', delProb.status === 200, `got ${delProb.status}`);
  const afterProbDel = await demo.get('/api/wrong-book/items');
  const orphan = afterProbDel.data.items.find((it) => it.problem_id === delPid);
  check('题目被删除后错题条目不消失', !!orphan, JSON.stringify(afterProbDel.data.items.map((i) => i.problem_id)));
  check('条目标记 problem_exists=false（页面据此提示「题目已删除」）', orphan?.problem_exists === false);
  const orphanDetail = await demo.get(`/api/wrong-book/items/${orphan.id}`);
  check('孤儿条目详情返回 problem=null 而不是 500', orphanDetail.status === 200 && orphanDetail.data.problem === null, `got ${orphanDetail.status}`);

  // ---------- 10. 纯函数 ----------
  section('10. 视觉返回的容错解析');
  const ctrl = await import('../controllers/wrongBookController.js');
  const fenced = ctrl.parseJsonLoose('```json\n{"topic":"a","text":"b","answer":"c","hints":["h"],"has_figure":true}\n```');
  check('带 ```json 围栏能解析', fenced?.text === 'b' && fenced?.has_figure === true, JSON.stringify(fenced));
  const chatty = ctrl.parseJsonLoose('好的，我识别到如下内容：\n{"topic":"a","text":"b","answer":"c","hints":[],"has_figure":false}\n希望有帮助！');
  check('带前后说明文字能解析', chatty?.text === 'b', JSON.stringify(chatty));
  check('纯垃圾返回 null', ctrl.parseJsonLoose('完全不是 JSON') === null);

  const nd = ctrl.normalizeDraft({ text: '  题面  ', topic: '', answer: '', hints: [] });
  check('normalizeDraft 补默认主题', nd.topic === '未分类');
  check('normalizeDraft 题面去空白', nd.text === '题面');
  check('normalizeDraft 无提示时补兜底提示', nd.hints.length === 2, JSON.stringify(nd.hints));
  check('normalizeDraft 提示最多 4 条', ctrl.normalizeDraft({ text: 'x', hints: ['1', '2', '3', '4', '5', '6'] }).hints.length === 4);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '));
  cleanup();
  await new Promise((r) => setTimeout(r, 600));
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  console.error(serverLog.slice(-3000));
  cleanup();
  process.exit(1);
});
