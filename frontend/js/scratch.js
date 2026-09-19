// ========== Canvas 手写草稿板 ==========
//
// 笔画数据结构：[{ t: "pen" | "eraser", p: [{x, y}] }]
// 坐标一律是 **CSS 像素**（相对画布左上角），不是设备像素。
//
// 为什么要留全量笔画、而不是只留一张位图：
// 画布尺寸会随「切 Tab / 软键盘弹收 / 旋屏 / 地址栏收起」变化，而**只要改动
// canvas.width 或 canvas.height，浏览器就会把位图整个清空**。移动端这些事件
// 触发得非常频繁（每次从「题目」切回「做题」都会重设尺寸），所以必须能把笔画
// 重放回去，否则孩子写到一半的手写内容会凭空消失。
var elCanvas = $("#scratch");
var ctx = elCanvas.getContext("2d");

var drawing = false,
  tool = "pen",
  lastX = 0,
  lastY = 0;

var PEN_WIDTH = 2.6; // 手指写字比鼠标粗，比原来的 2.4 略加一点
var ERASER_WIDTH = 18;
var ERASER_COLOR = "#fffef6"; // 与 #scratch 的背景色一致

function strokeStyleFor(t) {
  return t === "eraser"
    ? { color: ERASER_COLOR, width: ERASER_WIDTH }
    : { color: "#1f2937", width: PEN_WIDTH };
}

// 画一个点：点一下（tap）也应该留下痕迹，否则重放时点按会「消失」
function drawDot(x, y, style) {
  ctx.fillStyle = style.color;
  ctx.beginPath();
  ctx.arc(x, y, style.width / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawStroke(stroke) {
  const pts = stroke.p;
  if (!pts || !pts.length) return;
  const style = strokeStyleFor(stroke.t);
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = style.width;
  if (pts.length === 1) {
    drawDot(pts[0].x, pts[0].y, style);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

// 按 state.scratchStrokes 重放全部笔画（尺寸变化后恢复画面）
function redrawScratch() {
  ctx.clearRect(0, 0, elCanvas.width, elCanvas.height);
  for (const s of state.scratchStrokes) drawStroke(s);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = elCanvas.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  // 面板处于 display:none 时量到的是 0×0。此时若照样去设 width/height，
  // 会把画布清成一个 0×0 的空位图（内容永久丢失），所以直接跳过。
  if (w < 2 || h < 2) return;
  const pxW = Math.round(w * dpr);
  const pxH = Math.round(h * dpr);
  // 尺寸没变就别动 —— 避免无谓的重绘，也避免打断正在写的笔画
  if (elCanvas.width === pxW && elCanvas.height === pxH) return;
  elCanvas.width = pxW;
  elCanvas.height = pxH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  redrawScratch();
}

function clearCanvas() {
  ctx.clearRect(0, 0, elCanvas.width, elCanvas.height);
  state.scratchStrokes = [];
}

function undoScratch() {
  if (!state.scratchStrokes.length) {
    addSystemMsg("↩️ 没有可以撤销的笔画了。");
    return;
  }
  state.scratchStrokes.pop();
  redrawScratch();
}

function pos(e) {
  const r = elCanvas.getBoundingClientRect();
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
  return { x: t.clientX - r.left, y: t.clientY - r.top };
}

function start(e) {
  if (drawing) return; // 已有笔画在写，忽略第二个触点（掌托）
  if (e.touches && e.touches.length > 1) return; // 多指同时按下：不当作书写
  e.preventDefault();
  drawing = true;
  const p = pos(e);
  lastX = p.x;
  lastY = p.y;
  const stroke = { t: tool, p: [{ x: p.x, y: p.y }] };
  state.scratchStrokes.push(stroke);
  drawStroke(stroke); // 点按立刻留痕
}

function move(e) {
  if (!drawing) return;
  // 写到一半手掌搭上来会变成多指：直接结束这一笔，避免拖出一条乱线
  if (e.touches && e.touches.length > 1) {
    drawing = false;
    return;
  }
  e.preventDefault();
  const p = pos(e);
  const stroke = state.scratchStrokes[state.scratchStrokes.length - 1];
  if (!stroke) {
    drawing = false;
    return;
  }
  const style = strokeStyleFor(stroke.t);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  lastX = p.x;
  lastY = p.y;
  stroke.p.push({ x: p.x, y: p.y });
}

function end() {
  drawing = false;
  scheduleResize(); // 书写期间被跳过的尺寸变化，在这里补上
}

elCanvas.addEventListener("mousedown", start);
elCanvas.addEventListener("mousemove", move);
window.addEventListener("mouseup", end);
elCanvas.addEventListener("touchstart", start, { passive: false });
elCanvas.addEventListener("touchmove", move, { passive: false });
elCanvas.addEventListener("touchend", end);
elCanvas.addEventListener("touchcancel", end);

// ---- 尺寸变化：防抖，且不打断正在写的笔画 ----
var _resizeTimer = null;
function scheduleResize() {
  if (drawing) return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(resizeCanvas, 120);
}
window.addEventListener("resize", scheduleResize);
window.addEventListener("orientationchange", scheduleResize);

document.querySelectorAll(".tool").forEach((btn) => {
  if (!btn.dataset.tool) return;
  btn.addEventListener("click", () => {
    const t = btn.dataset.tool;
    if (t === "clear") {
      clearCanvas();
      return;
    }
    if (t === "undo") {
      undoScratch();
      return;
    }
    tool = t;
    document
      .querySelectorAll(".tool[data-tool]")
      .forEach((b) => b.classList.toggle("active", b === btn));
  });
});

// ========== 草稿同步到服务器 ==========
async function syncScratchToServer() {
  if (!state.sessionId) return;
  try {
    const strokeCount = state.scratchStrokes.length;
    // 先同步笔画数
    await fetch(`/api/session/${state.sessionId}/scratch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strokes: strokeCount }),
    });
    if (strokeCount > 0) {
      // 有笔迹：同步草稿图片（白底黑字JPEG），让AI可以随时调用recognize_scratch查看
      const dataUrl = exportScratchImage();
      if (!dataUrl) return;
      await fetch(`/api/session/${state.sessionId}/scratch-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: dataUrl,
          strokes: strokeCount,
        }),
      });
    } else {
      // 画布被清空：清除服务器上的草稿图片
      await fetch(`/api/session/${state.sessionId}/scratch-image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: null, strokes: 0 }),
      });
    }
  } catch {}
}

// ========== 导出草稿图片 / 上传 ==========
// 导出Canvas为白底黑字的清晰图片（JPEG压缩）
function exportScratchImage() {
  // 用**画布像素尺寸**（elCanvas.width/height），不要用 getBoundingClientRect：
  // 移动端在 AI Tab 上点「检查过程」时，「做题」面板是 display:none，
  // rect 会量到 0×0，导出就成了一张空图 —— AI 看到的是空白草稿。
  const w = elCanvas.width;
  const h = elCanvas.height;
  if (w < 2 || h < 2) return null; // 画布还没量过尺寸，宁可不发也别发空图

  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, w, h);
  octx.drawImage(elCanvas, 0, 0);

  return off.toDataURL("image/jpeg", 0.9);
}

// 上传草稿图片到服务器
async function uploadScratchImage() {
  if (!state.sessionId) return false;
  if (state.scratchStrokes.length === 0) {
    addSystemMsg("📝 草稿板是空的，先写点东西再识别吧。");
    return false;
  }
  const dataUrl = exportScratchImage();
  if (!dataUrl) {
    addSystemMsg("📝 画布还没准备好，请切到「做题」页看一眼再试。");
    return false;
  }
  try {
    await fetch(`/api/session/${state.sessionId}/scratch-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: dataUrl,
        strokes: state.scratchStrokes.length,
      }),
    });
    return true;
  } catch (e) {
    addErrorMsg("上传草稿图片失败: " + e.message);
    return false;
  }
}

// ========== 识别草稿按钮 ==========
var elRecognizeBtn = $("#recognize-scratch");
if (elRecognizeBtn) {
  elRecognizeBtn.addEventListener("click", async () => {
    if (state.turnInFlight) {
      addSystemMsg("⏳ AI正在处理中，请稍候...");
      return;
    }
    if (state.scratchStrokes.length === 0) {
      addSystemMsg("📝 草稿板是空的，先在草稿区写点东西再识别吧。");
      return;
    }
    addUserMsg("👁️ 请看看我草稿上写了什么");
    runTurn("请调用 recognize_scratch 工具识别我草稿板上的手写内容，告诉我我在草稿上写了什么算式和答案，帮我检查演算过程是否正确。如果发现错误，请用提问的方式引导我自己发现，不要直接告诉我正确答案。");
  });
}
