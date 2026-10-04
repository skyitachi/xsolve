// 错题本 controller
//
// 三种录入入口，共用 wrong_items 一张表：
//   auto   —— 做题答错时由 recordAttempt 自动收录（在 db.js 里，不经过本文件）
//   manual —— 从题库里挑一道已存在的题加入（POST /items）
//   photo  —— 拍照 → 视觉解析 → 新建题目并直接入本（POST /photo/parse + /photo/commit）
//
// 两条安全红线（与项目既有先例一致，改动前先想清楚）：
//   ① 任何面向前端的题目数据都**不能带 `answer` / `hints`** —— 这是孩子每天打开的页面，
//      一次 F12 就能把答案全看走。唯一的例外是拍照解析的**草稿**：那是用户自己
//      正在录入、需要核对识别是否准确的内容，不返回答案就无法校对。
//   ② 列表接口**不下发 `image_dataurl`** —— 那是整张图的 base64，几十条拍题错题就是几 MB，
//      手机上会明显卡。列表只给 has_image 标记，原图另走单独请求。
import {
  listWrongBooks,
  createWrongBook,
  renameWrongBook,
  deleteWrongBook,
  listWrongItems,
  getWrongItem,
  addWrongItem,
  removeWrongItem,
  setWrongItemMastered,
  touchWrongItemReview,
  recordWrongReview,
  setWrongItemMeta,
  getWrongBookStats,
  getWrongBookDueSummary,
  listWrongReviews,
  findWrongItemByProblem,
  getLatestWrongAnswer,
  getProblem,
  getProblemsForClient,
  insertProblem,
  ERROR_TYPES,
} from '../db.js';
import { runVisionHttp } from '../vision.js';
import { WRONG_BOOK_DAILY_LIMIT } from '../config.js';

// ========== 拍照解析 ==========

export const PHOTO_PARSE_PROMPT = `你是一个题目录入助手。用户会给你一张题目照片，照片里可能有学生的手写解答、涂改或老师的批改痕迹。

你只做「识别与整理」，不要讲解、不要输出解题过程。

严格按下面的 JSON 格式输出，不要输出任何额外文字、解释或代码块围栏：
{
  "topic": "主题分类，例如 立体几何 / 圆锥体积 / 行程问题",
  "text": "题面正文，保留完整条件与所求，公式用 LaTeX 的 $...$ 包裹",
  "answer": "标准答案，只写结果，例如 60° 或 1/3πr²h；若确实无法确定则填空字符串",
  "hints": ["2-3 条递进式提示，由浅入深，只给思路不给最终答案"],
  "has_figure": true 或 false，题目是否含图形（几何图、示意图、函数图像）
}

注意：
- 学生的手写内容、涂改、批改红叉**都不要**写进 text 或 answer，只识别印刷体的题目本体。
- 若图片不是一道题目（例如空白页、风景照、纯文字通知），把 text 设为空字符串。`;

const PHOTO_PARSE_USER_PROMPT = '请识别这张题目照片，按指定 JSON 格式输出结果。';

/**
 * 容错解析模型返回的 JSON。
 * 模型常把 JSON 包在 ```json 围栏里，或在前后附带一句说明 —— 两种都要兜住。
 * 解析失败返回 null，由调用方给出「换一张更清晰的图」这类可操作提示。
 */
export function parseJsonLoose(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* 继续尝试截取 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch { /* 放弃 */ }
  }
  return null;
}

export function normalizeDraft(j) {
  const topic = String(j?.topic || '').trim() || '未分类';
  const text = String(j?.text || '').trim();
  const answer = String(j?.answer ?? '').trim();
  let hints = Array.isArray(j?.hints) ? j.hints.map((h) => String(h || '').trim()).filter(Boolean) : [];
  if (!hints.length) hints = ['先看清题目给了哪些条件', '想想这类题的常用方法'];
  return { topic: topic.slice(0, 40), text, answer, hints: hints.slice(0, 4), has_figure: !!j?.has_figure };
}

function validateImage(image) {
  const m = String(image || '').match(/^data:image\/[a-zA-Z0-9.+-]+;base64,/);
  return !!m;
}

// ========== 本子 ==========

// GET /api/wrong-book/books
// 顺带返回总览统计，避免页面开两个请求
export function wbListBooks(req, res) {
  const sid = req.targetStudentId;
  res.json({ books: listWrongBooks(sid), stats: getWrongBookStats(sid) });
}

// POST /api/wrong-book/books  { name, emoji? }
export function wbCreateBook(req, res) {
  try {
    const book = createWrongBook(req.targetStudentId, {
      name: req.body?.name,
      emoji: req.body?.emoji,
    });
    res.json({ ok: true, book });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

// PATCH /api/wrong-book/books/:id  { name }
export function wbRenameBook(req, res) {
  try {
    const book = renameWrongBook(req.params.id, req.targetStudentId, req.body?.name);
    if (!book) return res.status(404).json({ error: '错题本不存在' });
    res.json({ ok: true, book });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

// DELETE /api/wrong-book/books/:id
// 默认本不可删；本子里的题目会移动回默认本，不会被连带删除。
export function wbDeleteBook(req, res) {
  const r = deleteWrongBook(req.params.id, req.targetStudentId);
  if (!r.ok) {
    const msg = r.reason === 'is_default' ? '默认错题本不能删除' : '错题本不存在';
    return res.status(r.reason === 'is_default' ? 400 : 404).json({ error: msg });
  }
  res.json({ ok: true, moved: r.moved, moved_to: r.moved_to });
}

// ========== 条目 ==========

const LIST_TEXT_MAX = 90;

// GET /api/wrong-book/items?bookId=&status=&errorType=&sort=&limit=&offset=&all=
// status: due（今日待复习）| pending | mastered | 省略 = 全部
export function wbListItems(req, res) {
  const { bookId, status, errorType, sort, limit, offset, all } = req.query;
  const sid = req.targetStudentId;
  // 每日上限：错题积压时把几十道全推给孩子，他会直接放弃。
  // all=1 是学生自己主动点「看全部到期」时才用的逃生口。
  const cap = (status === 'due' && all !== '1' && WRONG_BOOK_DAILY_LIMIT > 0)
    ? WRONG_BOOK_DAILY_LIMIT
    : null;
  const items = listWrongItems(sid, {
    bookId: bookId || null,
    status: status || null,
    errorType: errorType || null,
    sort: sort || null,
    limit: cap != null ? Math.min(Number(limit) || cap, cap) : limit,
    offset,
  });
  // 列表只给题面摘要：完整题面走详情接口，避免一次拉回几十道题的全文
  res.json({
    items: items.map((it) => ({
      ...it,
      text: it.text && it.text.length > LIST_TEXT_MAX ? it.text.slice(0, LIST_TEXT_MAX) + '…' : it.text,
    })),
    // 让前端能说出「今天还有 N 道」，而不是静默截断
    due_total: status === 'due' ? getWrongBookStats(sid).due : undefined,
    daily_limit: cap,
    error_types: ERROR_TYPES,
  });
}

// GET /api/wrong-book/items/:id —— 详情：完整题面 + 学生当时写的错误答案
export function wbGetItem(req, res) {
  const sid = req.targetStudentId;
  const item = getWrongItem(req.params.id, sid);
  if (!item) return res.status(404).json({ error: '错题不存在' });

  const p = getProblem(item.problem_id);
  const problem = p
    ? {
        id: p.id,
        topic: p.topic,
        text: p.text,          // 完整题面（错题本要看原题，不能只是摘要）
        figure: p.figure || null,
        // 注意：刻意不下发 answer / hints
      }
    : null;

  res.json({
    item: { ...item, text: undefined },
    problem,
    wrong_answer: getLatestWrongAnswer(sid, item.problem_id),
    // 复习流水：让「等级为什么是这个数」可解释，而不是只给一个黑盒数字
    reviews: listWrongReviews(item.id, sid, 8),
    error_types: ERROR_TYPES,
  });
}

// POST /api/wrong-book/items  { problemId | problemIds, bookId? }
// 手动把题库里已有的题目加入错题本（这是「将现有题目加入错题本」那条路）
export function wbAddItems(req, res) {
  const sid = req.targetStudentId;
  const body = req.body || {};
  const ids = Array.isArray(body.problemIds)
    ? body.problemIds
    : (body.problemId ? [body.problemId] : []);
  if (!ids.length) return res.status(400).json({ error: '缺少 problemId 或 problemIds' });

  const added = [];
  const skipped = [];
  const already = [];
  for (const rawId of ids.slice(0, 100)) {
    const pid = String(rawId);
    if (!getProblem(pid)) { skipped.push(pid); continue; }
    const existed = !!findWrongItemByProblem(sid, pid);
    try {
      // countWrong=false：手动加入不代表「又错了一次」，不能把错误次数刷高
      const r = addWrongItem(sid, { problemId: pid, bookId: body.bookId, source: 'manual', countWrong: false });
      (existed ? already : added).push(r.item.id);
    } catch (e) {
      skipped.push(pid);
      console.error('[wrong-book] add item failed:', pid, e.message);
    }
  }
  res.json({
    ok: true,
    added: added.length,
    already: already.length,
    skipped,
    message: added.length
      ? `已加入 ${added.length} 道题`
      : (already.length ? '这些题已经在错题本里了' : '没有可加入的题目'),
  });
}

// DELETE /api/wrong-book/items/:id
export function wbRemoveItem(req, res) {
  const ok = removeWrongItem(req.params.id, req.targetStudentId);
  if (!ok) return res.status(404).json({ error: '错题不存在' });
  res.json({ ok: true });
}

// POST /api/wrong-book/items/:id/master  { mastered }
export function wbMasterItem(req, res) {
  const mastered = req.body?.mastered !== false;
  const item = setWrongItemMastered(req.params.id, req.targetStudentId, mastered);
  if (!item) return res.status(404).json({ error: '错题不存在' });
  res.json({ ok: true, item });
}

// POST /api/wrong-book/items/:id/review
//   { correct: boolean } → 记一次**复习结果**并推进记忆等级（回流的手动入口）
//   {}                   → 兼容旧行为：只记「点了重做」这个动作，不结算
export function wbReviewItem(req, res) {
  const sid = req.targetStudentId;
  const id = req.params.id;
  const hasResult = req.body && typeof req.body.correct === 'boolean';

  if (!hasResult) {
    const item = touchWrongItemReview(id, sid);
    if (!item) return res.status(404).json({ error: '错题不存在' });
    return res.json({ ok: true, item });
  }

  const r = recordWrongReview(sid, { wrongId: id, correct: req.body.correct, fromBook: true });
  if (!r) return res.status(404).json({ error: '错题不存在' });
  res.json({
    ok: true,
    item: r.item,
    graduated: r.graduated,
    correct: r.correct,
    error_types: ERROR_TYPES,
  });
}

// POST /api/wrong-book/items/:id/meta  { error_type?: string|null, note?: string }
// 人工标注错因 / 备注 —— 错因三层里唯一高可靠的一层：人知道为什么错。
// error_type 传 null 表示"清空归因"（重新回到未归因）。
export function wbMetaItem(req, res) {
  try {
    const item = setWrongItemMeta(req.params.id, req.targetStudentId, {
      errorType: req.body?.error_type,
      note: req.body?.note,
    });
    if (!item) return res.status(404).json({ error: '错题不存在' });
    res.json({ ok: true, item, error_types: ERROR_TYPES });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
}

// GET /api/wrong-book/due —— 轻量接口：只回计数与主题分布，供对话侧注入摘要
export function wbDue(req, res) {
  res.json(getWrongBookDueSummary(req.targetStudentId));
}

// GET /api/wrong-book/candidates?bookId=&q=
// 手动加入用：题库全量（已剔除 answer）+ 标出哪些已在错题本里
export function wbCandidates(req, res) {
  const sid = req.targetStudentId;
  const { bookId, q } = req.query;
  const keyword = String(q || '').trim().toLowerCase();
  // getProblemsForClient 已剔除 answer / hints / source，但**保留了 figureImage（整张图的 base64）**。
  // 挑题列表必须把它剥掉，只留 has_image 标记 —— 否则题库里几十张图就是几 MB 的 JSON。
  const problems = getProblemsForClient().map(({ figureImage, ...rest }) => ({
    ...rest,
    has_image: !!figureImage,
  }));
  const rows = problems
    .filter((p) => !keyword
      || String(p.text || '').toLowerCase().includes(keyword)
      || String(p.topic || '').toLowerCase().includes(keyword))
    .map((p) => {
      const item = findWrongItemByProblem(sid, p.id);
      return {
        id: p.id,
        topic: p.topic,
        text: p.text && p.text.length > LIST_TEXT_MAX ? p.text.slice(0, LIST_TEXT_MAX) + '…' : p.text,
        has_image: p.has_image,
        in_book: !!item,
        in_this_book: !!(item && item.book_id === bookId),
        item_id: item ? item.id : null,
      };
    });
  res.json({ problems: rows });
}

// ========== 拍照解析录入 ==========

// POST /api/wrong-book/photo/parse  { image }
// 只解析、**不落库** —— 先让学生核对识别结果，确认后才提交。
// 视觉模型会把印刷体看错、把学生的手写当题干，直接入库会产生垃圾数据。
export async function wbPhotoParse(req, res) {
  const image = req.body?.image;
  if (!validateImage(image)) {
    return res.status(400).json({ error: '图片格式不对，请重新拍照' });
  }
  try {
    const raw = await runVisionHttp(image, null, PHOTO_PARSE_PROMPT, {
      userPrompt: PHOTO_PARSE_USER_PROMPT,
    });
    const json = parseJsonLoose(raw);
    if (!json) {
      return res.status(422).json({
        error: '没能从这张图里读出题目，换一张更清晰、只拍到一道题的图片试试',
        raw: String(raw || '').slice(0, 300),
      });
    }
    const draft = normalizeDraft(json);
    if (!draft.text) {
      return res.status(422).json({ error: '这张图里似乎没有题目，请重新拍摄' });
    }
    res.json({ ok: true, draft });
  } catch (e) {
    console.error('[wrong-book] photo parse failed:', e.message);
    res.status(502).json({ error: '识别失败：' + (e.message || String(e)) });
  }
}

// POST /api/wrong-book/photo/commit  { draft, image?, bookId? }
// 落库：新建题目（source='photo'）+ 直接入本。
export function wbPhotoCommit(req, res) {
  const sid = req.targetStudentId;
  const body = req.body || {};
  const draft = normalizeDraft(body.draft || {});
  if (!draft.text) return res.status(400).json({ error: '题面不能为空' });
  if (!draft.answer) return res.status(400).json({ error: '请先填写标准答案再保存' });

  const image = validateImage(body.image) ? body.image : null;
  const withFigure = !!image && (draft.has_figure || body.keep_image === true);

  try {
    const problem = insertProblem({
      topic: draft.topic,
      text: draft.text,
      answer: draft.answer,
      hints: draft.hints,
      figure: withFigure ? { type: 'image' } : undefined,
      imageDataUrl: withFigure ? image : null,
      source: 'photo',
    });
    // countWrong=false：拍照录入的是「以前做错过的题」，但录入动作本身
    // 不是一次新的错误 —— 错误次数应当由后续真实答错来累加。
    const { item, created } = addWrongItem(sid, {
      problemId: problem.id,
      bookId: body.bookId,
      source: 'photo',
      countWrong: false,
    });
    res.json({
      ok: true,
      created,
      item,
      // 回给前端的题目同样不带 answer / hints
      problem: { id: problem.id, topic: problem.topic, text: problem.text },
    });
  } catch (e) {
    console.error('[wrong-book] photo commit failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
}

// GET /api/wrong-book/items/:id/image —— 单独取原图，避免列表接口被 base64 撑爆
export function wbItemImage(req, res) {
  const item = getWrongItem(req.params.id, req.targetStudentId);
  if (!item) return res.status(404).json({ error: '错题不存在' });
  const p = getProblem(item.problem_id);
  if (!p || !p.imageDataUrl) return res.status(404).json({ error: '这道题没有图片' });
  res.json({ image: p.imageDataUrl });
}
