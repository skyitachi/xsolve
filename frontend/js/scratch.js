// ========== Canvas 手写草稿板 ==========
var elCanvas = $("#scratch");
var ctx = elCanvas.getContext("2d");

var drawing = false,
  tool = "pen",
  lastX = 0,
  lastY = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = elCanvas.getBoundingClientRect();
  elCanvas.width = rect.width * dpr;
  elCanvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function clearCanvas() {
  ctx.clearRect(0, 0, elCanvas.width, elCanvas.height);
  state.scratchStrokes = [];
}

function pos(e) {
  const r = elCanvas.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return { x: t.clientX - r.left, y: t.clientY - r.top };
}

function start(e) {
  e.preventDefault();
  drawing = true;
  const p = pos(e);
  lastX = p.x;
  lastY = p.y;
  state.scratchStrokes.push([{ x: p.x, y: p.y }]);
}

function move(e) {
  if (!drawing) return;
  e.preventDefault();
  const p = pos(e);
  ctx.strokeStyle = tool === "eraser" ? "#fffef6" : "#1f2937";
  ctx.lineWidth = tool === "eraser" ? 18 : 2.4;
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  lastX = p.x;
  lastY = p.y;
  const stroke = state.scratchStrokes[state.scratchStrokes.length - 1];
  if (stroke) stroke.push({ x: p.x, y: p.y });
}

function end() {
  drawing = false;
}

elCanvas.addEventListener("mousedown", start);
elCanvas.addEventListener("mousemove", move);
window.addEventListener("mouseup", end);
elCanvas.addEventListener("touchstart", start, { passive: false });
elCanvas.addEventListener("touchmove", move, { passive: false });
elCanvas.addEventListener("touchend", end);

document.querySelectorAll(".tool").forEach((btn) => {
  if (!btn.dataset.tool) return;
  btn.addEventListener("click", () => {
    const t = btn.dataset.tool;
    if (t === "clear") {
      clearCanvas();
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
  const dpr = window.devicePixelRatio || 1;
  const rect = elCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  // 创建离屏canvas，填充白色背景
  const off = document.createElement("canvas");
  off.width = w * dpr;
  off.height = h * dpr;
  const octx = off.getContext("2d");
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, w, h);
  // 将草稿canvas绘制在白色背景上
  octx.drawImage(elCanvas, 0, 0, w, h);

  const dataUrl = off.toDataURL("image/jpeg", 0.85);
  return dataUrl;
}

// 上传草稿图片到服务器
async function uploadScratchImage() {
  if (!state.sessionId) return false;
  if (state.scratchStrokes.length === 0) {
    addSystemMsg("📝 草稿板是空的，先写点东西再识别吧。");
    return false;
  }
  const dataUrl = exportScratchImage();
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
