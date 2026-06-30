// ========== 状态 ==========
const state = {
  problems: [], // 从后端 /api/problems 拉取（不含答案）
  idx: 0,
  sessionId: null,
  mode: localStorage.getItem("ai_mode") || "student", // 'student' | 'parent'
  history: JSON.parse(localStorage.getItem("practice_history") || "[]"),
  apiKey: localStorage.getItem("sf_api_key") || "",
  model: localStorage.getItem("sf_model") || "Qwen/Qwen2.5-32B-Instruct",
  baseUrl:
    localStorage.getItem("sf_base_url") || "https://api.siliconflow.cn/v1",
  scratchStrokes: [],
  turnInFlight: false,
  pendingNewSession: false,
};

function saveHistory() {
  state.history = state.history.slice(-50);
  localStorage.setItem("practice_history", JSON.stringify(state.history));
}

// ========== DOM ==========
const $ = (sel) => document.querySelector(sel);
const elProblemContent = $("#problem-content");
const elProblemFigure = $("#problem-figure");
const elProblemIndex = $("#problem-index");
const elProblemTopic = $("#problem-topic");
const elFinalAnswer = $("#final-answer");
const elChatLog = $("#chat-log");
const elChatInput = $("#chat-input");
const elChatSend = $("#chat-send");
const elCanvas = $("#scratch");
const ctx = elCanvas.getContext("2d");

// ========== Markdown 渲染 ==========
const MATH_PH = "\u0000MATH\u0000";

function _protectMath(src, blocks) {
  const pats = [
    /\$\$[\s\S]+?\$\$/g,
    /\\\[[\s\S]+?\\\]/g,
    /\$[^\$\n]+?\$/g,
    /\\\([^\\\n]+?\\\)/g,
  ];
  let out = src;
  let id = 0;
  for (const re of pats) {
    out = out.replace(re, (m) => {
      const ph = `${MATH_PH}${id}${MATH_PH}`;
      blocks[id] = m;
      id++;
      return ph;
    });
  }
  return out;
}

function _restoreMath(html, blocks) {
  for (let i = 0; i < blocks.length; i++) {
    const ph = `${MATH_PH}${i}${MATH_PH}`;
    html = html.split(ph).join(blocks[i]);
  }
  return html;
}

function renderMarkdown(src, opts = {}) {
  if (!src) return "";
  const escape = opts.escape !== false;
  let text = src;
  if (escape) text = escapeHtml(text);
  if (window.marked) {
    try {
      const blocks = [];
      const protected_text = _protectMath(text, blocks);
      let html = marked.parse(protected_text);
      if (blocks.length) html = _restoreMath(html, blocks);
      return html;
    } catch (e) {
      console.warn("Markdown parse error:", e);
    }
  }
  return escapeHtml(src).replace(/\n/g, "<br>");
}

function initMarked() {
  if (!window.marked) return;
  marked.setOptions({ breaks: true, gfm: true });
}

// ========== 渲染题目 ==========
function renderProblem() {
  const p = state.problems[state.idx];
  if (!p) return;
  elProblemIndex.textContent = `${state.idx + 1} / ${state.problems.length}`;
  elProblemTopic.textContent = p.topic;
  elProblemContent.classList.add("md-content");
  elProblemContent.innerHTML = renderMarkdown(p.text || "", { escape: false });
  renderMathInMsg(elProblemContent);
  elProblemFigure.innerHTML = "";
  if (p.figureImage) renderImageFigure(p.figureImage, elProblemFigure);
  else if (p.figure) renderFigure(p.figure, elProblemFigure);
  elFinalAnswer.value = "";
  clearCanvas();
}

// ========== 图片插图（保留题目原图）==========
function renderImageFigure(dataUrl, container) {
  const wrap = document.createElement("div");
  wrap.className = "figure-image-wrap";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "题目原图";
  const cap = document.createElement("div");
  cap.className = "figure-caption";
  cap.textContent = "🖼️ 题目原图";
  wrap.appendChild(img);
  wrap.appendChild(cap);
  container.appendChild(wrap);
}

// ========== 图形渲染 ==========
function renderFigure(fig, container) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 320 220");
  svg.setAttribute("width", "92%");
  svg.setAttribute("height", "92%");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  if (fig.type === "rect") {
    const scale = Math.min(180 / fig.width, 130 / fig.height);
    const w = fig.width * scale,
      h = fig.height * scale;
    const x = (320 - w) / 2 + 20,
      y = (220 - h) / 2 + 10;
    addEl(svg, svgNS, "rect", {
      x,
      y,
      width: w,
      height: h,
      fill: "#dbeafe",
      stroke: "#1d4ed8",
      "stroke-width": 2,
    });
    addText(svg, svgNS, x + w / 2, y - 8, `长 ${fig.width} ${fig.unit || ""}`);
    addText(
      svg,
      svgNS,
      x - 6,
      y + h / 2 + 4,
      `宽 ${fig.height}${fig.unit || ""}`,
      "end",
    );
  } else if (fig.type === "right-triangle") {
    renderInteractiveTriangle(svg, svgNS, fig);
  }
  container.appendChild(svg);
}
function addEl(parent, ns, name, attrs) {
  const el = document.createElementNS(ns, name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  parent.appendChild(el);
  return el;
}
function addText(parent, ns, x, y, text, anchor = "middle") {
  const t = document.createElementNS(ns, "text");
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.setAttribute("text-anchor", anchor);
  t.setAttribute("font-size", "13");
  t.setAttribute("fill", "#374151");
  t.textContent = text;
  parent.appendChild(t);
  return t;
}

function renderInteractiveTriangle(svg, ns, fig) {
  const scale = 28;
  let a = fig.a,
    b = fig.b;
  const rightCorner = { x: 80, y: 180 };
  const polygon = addEl(svg, ns, "polygon", {
    points: "",
    fill: "#fde68a",
    stroke: "#b45309",
    "stroke-width": 2,
  });
  const rightMark = addEl(svg, ns, "rect", {
    width: 12,
    height: 12,
    fill: "none",
    stroke: "#b45309",
    "stroke-width": 1.5,
  });
  const labelA = addText(svg, ns, 0, 0, "", "end");
  const labelB = addText(svg, ns, 0, 0, "", "middle");
  const labelC = addText(svg, ns, 0, 0, "", "middle");
  labelC.setAttribute("fill", "#6d28d9");
  const handleA = addEl(svg, ns, "circle", {
    r: 7,
    fill: "#4f46e5",
    stroke: "white",
    "stroke-width": 2,
    style: "cursor:ns-resize",
  });
  const handleB = addEl(svg, ns, "circle", {
    r: 7,
    fill: "#4f46e5",
    stroke: "white",
    "stroke-width": 2,
    style: "cursor:ew-resize",
  });
  const hint = addText(svg, ns, 160, 18, "👆 拖动蓝点改变三角形");
  hint.setAttribute("fill", "#9ca3af");
  function redraw() {
    const ap = { x: rightCorner.x, y: rightCorner.y - a * scale };
    const bp = { x: rightCorner.x + b * scale, y: rightCorner.y };
    polygon.setAttribute(
      "points",
      `${rightCorner.x},${rightCorner.y} ${bp.x},${bp.y} ${ap.x},${ap.y}`,
    );
    rightMark.setAttribute("x", rightCorner.x);
    rightMark.setAttribute("y", rightCorner.y - 12);
    labelA.setAttribute("x", rightCorner.x - 8);
    labelA.setAttribute("y", (rightCorner.y + ap.y) / 2);
    labelA.textContent = `a = ${a}`;
    labelB.setAttribute("x", (rightCorner.x + bp.x) / 2);
    labelB.setAttribute("y", rightCorner.y + 18);
    labelB.textContent = `b = ${b}`;
    const c = Math.sqrt(a * a + b * b);
    labelC.setAttribute("x", (ap.x + bp.x) / 2 + 12);
    labelC.setAttribute("y", (ap.y + bp.y) / 2 - 4);
    labelC.textContent = `c = ${c.toFixed(2)}`;
    handleA.setAttribute("cx", ap.x);
    handleA.setAttribute("cy", ap.y);
    handleB.setAttribute("cx", bp.x);
    handleB.setAttribute("cy", bp.y);
  }
  redraw();
  function svgPos(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  let dragging = null;
  function down(which) {
    return (e) => {
      dragging = which;
      e.preventDefault();
    };
  }
  handleA.addEventListener("mousedown", down("a"));
  handleB.addEventListener("mousedown", down("b"));
  handleA.addEventListener("touchstart", down("a"), { passive: false });
  handleB.addEventListener("touchstart", down("b"), { passive: false });
  function moveSvg(e) {
    if (!dragging) return;
    e.preventDefault();
    const evt = e.touches ? e.touches[0] : e;
    const p = svgPos(evt);
    if (dragging === "a")
      a = Math.min(10, Math.max(1, Math.round((rightCorner.y - p.y) / scale)));
    else
      b = Math.min(10, Math.max(1, Math.round((p.x - rightCorner.x) / scale)));
    redraw();
  }
  function up() {
    dragging = null;
  }
  svg.addEventListener("mousemove", moveSvg);
  window.addEventListener("mouseup", up);
  svg.addEventListener("touchmove", moveSvg, { passive: false });
  window.addEventListener("touchend", up);
}

// ========== 画布 ==========
let drawing = false,
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

// ========== 上传手写图片 ==========
const elUploadInput = $("#upload-input");
const elUploadInputProblem = $("#upload-input-problem");
const elUploadPreview = $("#upload-preview");
const elUploadThumb = $("#upload-thumb");
let pendingUpload = null; // { dataUrl, mediaType, base64, mode: 'answer' | 'problem' }

async function fileToImageBlob(file, maxSize = 1280) {
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxSize || height > maxSize) {
    const r = Math.min(maxSize / width, maxSize / height);
    width = Math.round(width * r);
    height = Math.round(height * r);
  }
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d").drawImage(img, 0, 0, width, height);
  const outUrl = c.toDataURL("image/jpeg", 0.85);
  const [meta, b64] = outUrl.split(",");
  const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  return { dataUrl: outUrl, mediaType, base64: b64 };
}

async function handleUploadFile(file, mode) {
  try {
    const blob = await fileToImageBlob(file);
    pendingUpload = { ...blob, mode };
    elUploadThumb.src = pendingUpload.dataUrl;
    const send = $("#upload-send");
    send.textContent =
      mode === "problem" ? "识别为新题（会弹窗确认）" : "发给 AI 检查";
    elUploadPreview.hidden = false;
  } catch (err) {
    addErrorMsg("图片处理失败: " + err.message);
  }
}

async function autoRecognizeProblemImage(file) {
  try {
    const blob = await fileToImageBlob(file);
    const prompt =
      "这是一道题目的图片。请仔细识别图片里的题面（有公式就用 LaTeX $...$ 表示），判断主题类型，给出正确答案和 2-3 条递进提示，然后调用 propose_problem 工具向我提议这道新题。" +
      '注意：你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。如果原图含有题目相关图形，务必设 figure: {type:"image"}。';
    addUserMsg("（拖拽上传题目图片，请识别为新题）", blob.dataUrl);
    runTurn(prompt, {
      image: { mediaType: blob.mediaType, data: blob.base64 },
    });
  } catch (err) {
    addErrorMsg("图片处理失败: " + err.message);
  }
}

elUploadInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await handleUploadFile(file, "answer");
  elUploadInput.value = "";
});
elUploadInputProblem.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await autoRecognizeProblemImage(file);
  elUploadInputProblem.value = "";
});

// ---------- 拖拽上传 ----------
// 做题区面板 -> 默认解答；题目区面板 -> 默认题目；聊天区面板 -> 默认解答
function setupDropZone(el, defaultMode, label) {
  if (!el) return;
  let depth = 0;
  const isImage = (f) => f && f.type && f.type.startsWith("image/");
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay";
  overlay.textContent = `松开鼠标：作为「${label}」上传`;
  el.appendChild(overlay);
  el.classList.add("drop-host");

  el.addEventListener("dragenter", (e) => {
    if (
      !e.dataTransfer ||
      !Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")
    )
      return;
    e.preventDefault();
    depth++;
    el.classList.add("drag-over");
  });
  el.addEventListener("dragover", (e) => {
    if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  el.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove("drag-over");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove("drag-over");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!isImage(file)) {
      addSystemMsg("⚠️ 请拖入图片文件");
      return;
    }
    const useAlt = e.shiftKey;
    let mode = defaultMode;
    if (useAlt) mode = defaultMode === "answer" ? "problem" : "answer";
    if (mode === "problem") {
      await autoRecognizeProblemImage(file);
    } else {
      await handleUploadFile(file, mode);
    }
  });
}

setupDropZone($(".panel-work"), "answer", "我的解答（按住 Shift 改为题目）");
setupDropZone(
  $(".panel-problem"),
  "problem",
  "题目图片（按住 Shift 改为解答）",
);
setupDropZone($(".panel-ai"), "answer", "我的解答（按住 Shift 改为题目）");

// ---------- 粘贴图片上传 ----------
document.addEventListener("paste", async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const activeEl = document.activeElement;
      const inProblemPanel = activeEl && $(".panel-problem").contains(activeEl);
      const inChatInput = activeEl === elChatInput;
      if (inProblemPanel && !inChatInput) {
        await autoRecognizeProblemImage(file);
      } else {
        await handleUploadFile(file, "answer");
      }
      break;
    }
  }
});

$("#upload-cancel").addEventListener("click", () => {
  pendingUpload = null;
  elUploadPreview.hidden = true;
});

$("#upload-send").addEventListener("click", () => {
  if (!pendingUpload) return;
  const caption = elChatInput.value.trim();
  let prompt;
  if (pendingUpload.mode === "problem") {
    prompt =
      caption ||
      "这是一道题目的图片。请仔细识别图片里的题面（有公式就用 LaTeX $...$ 表示），判断主题类型，给出正确答案和 2-3 条递进提示，然后调用 propose_problem 工具向我提议这道新题。" +
        "注意：你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。";
    addUserMsg(
      caption || "（上传了一张题目图片，请识别为新题）",
      pendingUpload.dataUrl,
    );
  } else {
    prompt =
      caption ||
      "这是我写在纸上的做题过程 / 答案，请帮我看看对不对、有没有需要改进的地方。";
    addUserMsg(caption || prompt, pendingUpload.dataUrl);
  }
  elChatInput.value = "";
  runTurn(prompt, {
    image: { mediaType: pendingUpload.mediaType, data: pendingUpload.base64 },
  });
  pendingUpload = null;
  elUploadPreview.hidden = true;
});

// ========== 聊天 UI ==========
function addUserMsg(text, imageDataUrl) {
  const div = document.createElement("div");
  div.className = "msg msg-user md-content";
  if (text) {
    const span = document.createElement("span");
    span.innerHTML = renderMarkdown(text, { escape: true });
    div.appendChild(span);
  }
  if (imageDataUrl) {
    const img = document.createElement("img");
    img.src = imageDataUrl;
    img.className = "uploaded";
    div.appendChild(img);
  }
  elChatLog.appendChild(div);
  renderMathInMsg(div);
  scrollChat();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMathInMsg(el) {
  if (window.renderMathInElement) {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    });
  }
}

function renderAiBlock(block, isFinal) {
  if (!block || !block.div) return;
  const html = renderMarkdown(block.rawBuf || "", { escape: false });
  block.div.innerHTML = html;
  block.div.classList.toggle("streaming", !isFinal);
  if (!isFinal) {
    const cursor = document.createElement("span");
    cursor.className = "stream-cursor";
    cursor.textContent = "\u258D";
    block.div.appendChild(cursor);
  }
  if (isFinal) {
    renderMathInMsg(block.div);
  }
}

function addAiMsg(text = "") {
  const div = document.createElement("div");
  div.className = "msg msg-ai md-content";
  const block = { type: "text", div, rawBuf: text };
  renderAiBlock(block, true);
  elChatLog.appendChild(div);
  scrollChat();
  return div;
}

function addErrorMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  const icon = document.createElement('div');
  icon.className = 'error-icon';
  icon.textContent = '\u26A0\uFE0F';
  const body = document.createElement('div');
  body.className = 'error-body';
  const title = document.createElement('div');
  title.className = 'error-title';
  title.textContent = '出错了';
  const content = document.createElement('div');
  content.className = 'error-content';
  content.textContent = text;
  body.appendChild(title);
  body.appendChild(content);
  div.appendChild(icon);
  div.appendChild(body);
  elChatLog.appendChild(div);
  scrollChat();
}

function addSystemMsg(text) {
  const div = document.createElement("div");
  div.className = "msg msg-system md-content";
  div.innerHTML = renderMarkdown(text, { escape: false });
  elChatLog.appendChild(div);
  renderMathInMsg(div);
  scrollChat();
}
function scrollChat() {
  elChatLog.scrollTop = elChatLog.scrollHeight;
}

// ========== AI 状态指示器 ==========
const elStatus = $("#ai-status");
const elStatusText = elStatus.querySelector(".status-text");
const elStatusTimer = elStatus.querySelector(".status-timer");
const AiStatus = {
  startedAt: 0,
  timerHandle: 0,
  stallHandle: 0,
  activeTools: 0,
  set(kind, text) {
    elStatus.className = "ai-status status-" + kind;
    elStatusText.textContent = text;
  },
  begin(text = "思考中…") {
    this.startedAt = Date.now();
    this.activeTools = 0;
    this.set("thinking", text);
    elStatusTimer.hidden = false;
    clearInterval(this.timerHandle);
    this.timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      const m = Math.floor(s / 60);
      elStatusTimer.textContent = m ? `${m}m ${s % 60}s` : `${s}s`;
    }, 300);
    this.resetStall();
  },
  resetStall() {
    clearTimeout(this.stallHandle);
    this.stallHandle = setTimeout(() => {
      // 8s 无新事件 -> 提示可能被卡（网络/模型加载/OCR 长图）
      elStatus.classList.add("status-stalled");
      elStatus.classList.remove(
        "status-thinking",
        "status-tool",
        "status-streaming",
      );
      elStatusText.textContent = "仍在处理…（图片识别可能耗时）";
    }, 8000);
  },
  tick(text, kind = "thinking") {
    this.set(kind, text);
    this.resetStall();
  },
  toolStart(name) {
    this.activeTools++;
    this.tick(`调用工具 ${name} …`, "tool");
  },
  toolEnd() {
    this.activeTools = Math.max(0, this.activeTools - 1);
    if (this.activeTools === 0) this.tick("工具完成，继续思考…", "thinking");
  },
  streaming() {
    this.tick("AI 正在回答…", "streaming");
  },
  done() {
    clearInterval(this.timerHandle);
    clearTimeout(this.stallHandle);
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    this.set("done", `完成`);
    elStatusTimer.hidden = false;
    elStatusTimer.textContent = `${s}s`;
    setTimeout(() => this.reset(), 4000);
  },
  error(msg) {
    clearInterval(this.timerHandle);
    clearTimeout(this.stallHandle);
    this.set("error", "出错：" + (msg || "未知"));
    setTimeout(() => this.reset(), 8000);
  },
  reset() {
    clearInterval(this.timerHandle);
    clearTimeout(this.stallHandle);
    this.set("idle", "待命");
    elStatusTimer.hidden = true;
    elStatusTimer.textContent = "";
  },
};

// 工具调用卡片（Claude-Code 风格）
const TOOL_LABELS = {
  list_problems: "📚 列出题库",
  get_current_problem: "📖 读取当前题",
  get_problem: "📖 读取题目",
  set_current_problem: "🔀 切换题目",
  delete_problem: "🗑️ 删除题目",
  propose_problem: "🎯 出新题",
  recognize_problem_image: "👁️ 视觉子代理识别",
  check_answer: "✅ 判答",
  record_history: "💾 记录历史",
  ability_report: "📊 水平评估",
  read_scratch_state: "🖊️ 检查草稿",
  calc: "🧮 计算",
};
function addToolCallCard(label, args) {
  const card = document.createElement("div");
  card.className = "tool-card";
  const argText = Object.keys(args || {}).length ? JSON.stringify(args) : "";
  card.innerHTML = `
    <div class="tool-head">
      <span class="tool-name">${label}</span>
      <span class="tool-status running">运行中…</span>
    </div>
    <pre class="tool-args"></pre>
    <pre class="tool-result" hidden></pre>
  `;
  card.querySelector(".tool-args").textContent = argText;
  elChatLog.appendChild(card);
  scrollChat();
  return card;
}
function finishToolCard(card, result, isError = false) {
  const statusEl = card.querySelector(".tool-status");
  statusEl.textContent = isError ? "失败" : "完成";
  statusEl.classList.remove("running");
  statusEl.classList.add(isError ? "error" : "done");
  const resEl = card.querySelector(".tool-result");
  resEl.hidden = false;
  resEl.textContent =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  scrollChat();
}

// ========== 会话与 agent ==========
async function createSession(mode = state.mode || "student") {
  const resp = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!resp.ok) throw new Error("创建会话失败: " + resp.status);
  const data = await resp.json();
  state.sessionId = data.id;
  state.mode = data.mode || mode;
  return data;
}

async function loadProblems() {
  const resp = await fetch("/api/problems");
  state.problems = await resp.json();
}

async function syncScratchToServer() {
  if (!state.sessionId) return;
  try {
    await fetch(`/api/session/${state.sessionId}/scratch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strokes: state.scratchStrokes.length }),
    });
  } catch {}
}

async function runTurn(userText, opts = {}) {
  if (state.turnInFlight) {
    addSystemMsg("⏳ AI正在处理中，请稍候再发送...");
    return;
  }
  if (!state.sessionId) {
    addErrorMsg("会话尚未就绪，请刷新页面重试。");
    return;
  }
  state.turnInFlight = true;
  elChatSend.disabled = true;
  let streamDone = false;
  try {
    const hasMedia = opts.image || opts.audio;
    AiStatus.begin(hasMedia ? "正在上传媒体…" : "思考中…");
    await syncScratchToServer();

    const currentProblem = state.problems[state.idx];
    const bodyPayload = {
      message: userText,
      image: opts.image || null,
      audio: opts.audio || null,
      currentProblemId: currentProblem ? currentProblem.id : null,
      scratchStrokes: state.scratchStrokes.length,
    };
    const resp = await fetch(`/api/session/${state.sessionId}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyPayload),
    });
    if (!resp.ok || !resp.body) {
      let errText = `HTTP ${resp.status} ${resp.statusText || ""}`;
      try {
        const t = await resp.text();
        if (t) {
          try {
            const j = JSON.parse(t);
            errText = j.error || t;
          } catch { errText = t; }
        }
      } catch {}
      addErrorMsg(`请求失败：\n${errText}`);
      AiStatus.error("HTTP " + resp.status);
      return;
    }
    if (opts.image) AiStatus.tick("模型识别图片中…", "thinking");
    else if (opts.audio) AiStatus.tick("模型识别语音中…", "thinking");
    await readSSE(resp.body, () => { streamDone = true; });
    if (!streamDone) {
      addErrorMsg("连接异常中断：AI 未返回完整结果，请重试。");
      AiStatus.error("连接中断");
    }
  } catch (e) {
    addErrorMsg(`网络/系统错误：\n${e.message || String(e)}`);
    AiStatus.error(e.message || "网络错误");
  } finally {
    state.turnInFlight = false;
    elChatSend.disabled = false;
  }
}

async function readSSE(stream, onDone) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const toolCards = {};
  const partialState = { blocks: {}, activeTextDiv: null };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split("\n");
      let event = "message",
        data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      let payload = {};
      try {
        payload = JSON.parse(data);
      } catch {}
      handleEvent(event, payload, toolCards, partialState);
      if (event === "done" && onDone) onDone();
    }
  }
}

function handleEvent(event, payload, toolCards, partialState) {
  switch (event) {
    case "user":
      break;
    case "sdk_message":
      AiStatus.resetStall();
      handleSdkMessage(payload, toolCards, partialState);
      break;
    case "ui_event":
      handleUiEvent(payload);
      break;
    case "error":
      addErrorMsg(payload.message || "未知错误");
      AiStatus.error(payload.message || "未知");
      state.pendingNewSession = false;
      break;
    case "done":
      AiStatus.done();
      if (state.pendingNewSession) {
        state.pendingNewSession = false;
        (async () => {
          try {
            await createSession(state.mode);
            addSystemMsg("💬 新对话已开启（切换题目不清除历史记录）。");
          } catch (e) {
            addErrorMsg("创建新会话失败: " + e.message);
          }
        })();
      }
      break;
  }
}

// Claude Agent SDK 消息形状 (SDKMessage)
// - { type: 'assistant', message: BetaMessage }  message.content 是 content blocks 数组
// - { type: 'user', message: { role, content: [tool_result blocks...] } }
// - { type: 'result', ... } 一轮结束
// - { type: 'system' / 'status' / ... } 其他诊断信息
function handleSdkMessage(msg, toolCards, partialState) {
  if (!msg || !msg.type) return;
  if (msg.type === "stream_event") {
    handleStreamEvent(msg.event, toolCards, partialState);
    return;
  }
  if (
    msg.type === "assistant" &&
    msg.message &&
    Array.isArray(msg.message.content)
  ) {
    // 已通过 stream_event 实时渲染过；只补救：若某个 tool_use 没在 partial 流里出现（极少见），这里兜底渲染
    for (const block of msg.message.content) {
      if (block.type === "tool_use" && !toolCards[block.id]) {
        toolCards[block.id] = addToolCallCard(
          prettyToolName(block.name),
          block.input || {},
        );
      }
    }
  } else if (
    msg.type === "user" &&
    msg.message &&
    Array.isArray(msg.message.content)
  ) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        const card = toolCards[block.tool_use_id];
        let payload = block.content;
        if (Array.isArray(payload)) {
          payload = payload
            .map((c) => (c.type === "text" ? safeJsonParse(c.text) : c))
            .map(stringify)
            .join("\n");
        }
        if (card) finishToolCard(card, payload, !!block.is_error);
        AiStatus.toolEnd();
      }
    }
  } else if (msg.type === "result") {
    if (partialState.activeTextDiv) renderMathInMsg(partialState.activeTextDiv);
  } else if (msg.type === "api_retry") {
    AiStatus.tick(
      `模型繁忙，正在重试（第 ${msg.attempt || "?"} 次）…`,
      "thinking",
    );
  } else if (msg.type === "status") {
    if (msg.subtype && /throttl|retry|slow/i.test(msg.subtype)) {
      AiStatus.tick("服务较慢，请稍候…", "thinking");
    }
  } else if (msg.type === "system") {
    // SDK init / hook info; skip rendering
  }
}

// Anthropic 流式事件 (BetaRawMessageStreamEvent)：
// - message_start
// - content_block_start { index, content_block: {type:'text'|'tool_use'|'thinking', ...} }
// - content_block_delta { index, delta: {type:'text_delta', text:'...'} | {type:'input_json_delta', partial_json:'...'} }
// - content_block_stop  { index }
// - message_delta / message_stop
function handleStreamEvent(ev, toolCards, st) {
  if (!ev || !ev.type) return;
  if (ev.type === "message_start") {
    st.blocks = {};
    st.activeTextDiv = null;
  } else if (ev.type === "content_block_start") {
    const cb = ev.content_block || {};
    if (cb.type === "text") {
      const div = document.createElement("div");
      div.className = "msg msg-ai md-content streaming";
      elChatLog.appendChild(div);
      st.blocks[ev.index] = { type: "text", div, rawBuf: "" };
      st.activeTextDiv = div;
      AiStatus.streaming();
    } else if (cb.type === "tool_use") {
      const card = addToolCallCard(prettyToolName(cb.name), {});
      toolCards[cb.id] = card;
      st.blocks[ev.index] = {
        type: "tool_use",
        cardId: cb.id,
        name: cb.name,
        jsonBuf: "",
      };
      AiStatus.toolStart(prettyToolName(cb.name));
    } else if (cb.type === "thinking") {
      st.blocks[ev.index] = { type: "thinking" };
    }
  } else if (ev.type === "content_block_delta") {
    const block = st.blocks && st.blocks[ev.index];
    if (!block) return;
    const d = ev.delta || {};
    if (block.type === "text" && d.type === "text_delta" && d.text) {
      block.rawBuf += d.text;
      renderAiBlock(block, false);
      scrollChat();
    } else if (
      block.type === "tool_use" &&
      d.type === "input_json_delta" &&
      d.partial_json
    ) {
      block.jsonBuf += d.partial_json;
      const card = toolCards[block.cardId];
      if (card) card.querySelector(".tool-args").textContent = block.jsonBuf;
    }
  } else if (ev.type === "content_block_stop") {
    const block = st.blocks && st.blocks[ev.index];
    if (block && block.type === "text" && block.div) {
      renderAiBlock(block, true);
      scrollChat();
    }
  }
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function stringify(v) {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}
function prettyToolName(name) {
  // mcp__tutor__set_current_problem -> set_current_problem
  const short = name.replace(/^mcp__[^_]+__/, "");
  return TOOL_LABELS[short] || "🔧 " + short;
}

function handleUiEvent(ev) {
  if (ev.type === "set_problem") {
    const newIdx = state.problems.findIndex((p) => p.id === ev.problem_id);
    if (newIdx >= 0 && newIdx !== state.idx) {
      state.idx = newIdx;
      renderProblem();
      addSystemMsg(`AI 已为你切换到第 ${state.idx + 1} 题`);
    }
  } else if (ev.type === "history_updated") {
    // 已由 SDK 工具结果驱动
  } else if (ev.type === "problem_proposed") {
    showProposalDialog(ev.problem);
  } else if (ev.type === "problems_changed") {
    // 题库变动（删除/新增），重新拉取并定位
    refreshProblemsAfterChange(ev.current_problem_id, ev.deleted_id);
  } else if (ev.type === "vision_subagent_started") {
    AiStatus.tick(`视觉子代理识别中（${ev.model || "vision"}）…`, "tool");
  } else if (ev.type === "vision_subagent_done") {
    AiStatus.tick("视觉子代理完成，主代理继续…", "thinking");
  }
}

async function refreshProblemsAfterChange(currentId, deletedId) {
  await loadProblems();
  if (deletedId) addSystemMsg(`🗑️ 已删除题目 ${deletedId}，切换到新题目后将开始新会话。`);
  if (!state.problems.length) {
    addSystemMsg("题库已空。可以让 AI 出一道新题。");
    state.idx = 0;
    renderProblem();
    return;
  }
  const wantId = currentId || (state.problems[0] && state.problems[0].id);
  const found = state.problems.findIndex((p) => p.id === wantId);
  state.idx = found >= 0 ? found : 0;
  renderProblem();
  if (deletedId) {
    state.pendingNewSession = true;
  }
}

// AI 出题确认
const elProposalDialog = $("#proposal-dialog");
const elProposalText = $("#proposal-text");
const elProposalTopic = $("#proposal-topic");
const elProposalHints = $("#proposal-hints");
const elProposalFigure = $("#proposal-figure");
let pendingProposal = null;
function showProposalDialog(problem) {
  pendingProposal = problem;
  elProposalTopic.textContent = problem.topic || "新题";
  elProposalText.classList.add("md-content");
  elProposalText.innerHTML = renderMarkdown(problem.text || "", { escape: false });
  renderMathInMsg(elProposalText);
  elProposalFigure.innerHTML = "";
  if (problem.figureImage) {
    renderImageFigure(problem.figureImage, elProposalFigure);
  } else if (problem.figure) {
    renderFigure(problem.figure, elProposalFigure);
  }
  elProposalHints.innerHTML = "";
  (problem.hints || []).forEach((h) => {
    const li = document.createElement("li");
    li.innerHTML = renderMarkdown(h, { escape: false });
    elProposalHints.appendChild(li);
    renderMathInMsg(li);
  });
  elProposalDialog.showModal();
}
$("#proposal-accept").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!pendingProposal) {
    elProposalDialog.close();
    return;
  }
  const p = pendingProposal;
  // 插入到 state.problems 末尾，并切换
  state.problems.push(p);
  state.idx = state.problems.length - 1;
  renderProblem();
  addSystemMsg(`🎯 已替换为 AI 出的新题：${p.topic}`);
  elProposalDialog.close();
  try {
    await fetch(`/api/session/${state.sessionId}/proposal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept", problem_id: p.id }),
    });
  } catch {}
  pendingProposal = null;
});
$("#proposal-cancel").addEventListener("click", async (e) => {
  e.preventDefault();
  const id = pendingProposal && pendingProposal.id;
  elProposalDialog.close();
  pendingProposal = null;
  addSystemMsg("已取消 AI 出的新题。");
  if (id) {
    try {
      await fetch(`/api/session/${state.sessionId}/proposal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", problem_id: id }),
      });
    } catch {}
  }
});

// ========== 手动输入题目 ==========
const elManualInputDialog = $("#manual-input-dialog");
const elManualInputText = $("#manual-input-text");
$("#manual-input-btn").addEventListener("click", () => {
  elManualInputText.value = "";
  elManualInputDialog.showModal();
  setTimeout(() => elManualInputText.focus(), 100);
});
$("#manual-input-cancel").addEventListener("click", (e) => {
  e.preventDefault();
  elManualInputDialog.close();
});
$("#manual-input-submit").addEventListener("click", async (e) => {
  e.preventDefault();
  if (isRecording) {
    showVoiceStatus("⏹️ 正在停止录音...");
    await stopRecording();
  }
  const text = elManualInputText.value.trim();
  if (!text && !recordedAudioBase64) {
    alert("请输入题目内容或先录音");
    return;
  }
  elManualInputDialog.close();
  const hasAudio = !!recordedAudioBase64;
  let prompt;
  if (hasAudio) {
    prompt = `这是我语音输入的一道数学题，${text ? "同时附上了语音转文字的参考文本：\n\n" + text + "\n\n" : ""}请你仔细听录音，准确理解题面内容（如果参考文本有误，以录音为准；公式用 $...$ 表示），判断主题类型，给出正确答案和 2-3 条递进提示，然后调用 propose_problem 工具向我提议这道新题。注意：你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。`;
    addUserMsg("（语音输入题目）\n" + (text || "（见录音）"));
  } else {
    prompt = `这是我手动输入的一道题，请仔细理解题面（公式用 $...$ 表示），判断主题类型，给出正确答案和 2-3 条递进提示，然后调用 propose_problem 工具向我提议这道新题。题面如下：\n\n${text}\n\n注意：你不必自己切换题目；propose_problem 会弹窗让我确认是否替换当前题。`;
    addUserMsg("（手动输入题目）\n" + text);
  }
  const opts = {};
  if (hasAudio) {
    opts.audio = {
      mediaType: recordedAudioMimeType,
      data: recordedAudioBase64,
    };
  }
  runTurn(prompt, opts);
  clearRecordedAudio();
});
elManualInputText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    $("#manual-input-submit").click();
  }
});

// ========== 语音输入（同时录音 + 实时转写） ==========
const elVoiceBtn = $("#voice-input-btn");
const elVoiceStatus = $("#voice-status");
const elVoicePreview = $("#voice-preview");
const elVoiceDuration = $("#voice-duration");
const elVoiceAudio = $("#voice-audio");
const elVoiceDiscard = $("#voice-discard");
let recognition = null;
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let recordedAudioBlob = null;
let recordedAudioBase64 = null;
let recordedAudioMimeType = "";
let isRecording = false;
let finalTranscript = "";
let recordStartTime = 0;
let recordTimerHandle = null;

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateRecordDuration() {
  const elapsed = Date.now() - recordStartTime;
  elVoiceDuration.textContent = "⏱️ " + formatDuration(elapsed);
}

function showVoiceStatus(text, type = "info") {
  elVoiceStatus.textContent = text;
  elVoiceStatus.hidden = false;
  elVoiceStatus.className =
    "voice-status" + (type !== "info" ? " " + type : "");
}

function hideVoiceStatus() {
  elVoiceStatus.hidden = true;
}

function clearRecordedAudio() {
  recordedAudioBlob = null;
  recordedAudioBase64 = null;
  recordedAudioMimeType = "";
  elVoicePreview.hidden = true;
  elVoiceAudio.src = "";
  if (recordTimerHandle) {
    clearInterval(recordTimerHandle);
    recordTimerHandle = null;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result.split(",")[1];
      resolve(base64data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function initSpeechRecognition() {
  if (recognition) return true;
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return false;
  recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interimTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    const fullText = finalTranscript + interimTranscript;
    elManualInputText.value = fullText;
    if (interimTranscript) {
      showVoiceStatus("🎤 识别中: " + interimTranscript);
    } else {
      showVoiceStatus(
        "🎤 正在聆听... " + formatDuration(Date.now() - recordStartTime),
      );
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    if (event.error === "no-speech" || event.error === "aborted") return;
    let errorMsg = "语音识别出错";
    switch (event.error) {
      case "not-allowed":
      case "service-not-allowed":
        errorMsg = "❌ 麦克风权限被拒绝";
        break;
      case "audio-capture":
        errorMsg = "❌ 未检测到麦克风设备";
        break;
      case "network":
        errorMsg = "⚠️ 语音转文字需要网络，录音仍在保存中";
        break;
      default:
        errorMsg = "⚠️ 识别问题: " + event.error + "（录音仍在保存）";
    }
    showVoiceStatus(errorMsg, "error");
  };

  recognition.onend = () => {
    if (isRecording) {
      try {
        recognition.start();
      } catch (e) {}
    }
  };

  return true;
}

async function startRecording() {
  clearRecordedAudio();
  finalTranscript = elManualInputText.value
    ? elManualInputText.value + " "
    : "";
  elManualInputText.value = finalTranscript;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showVoiceStatus("❌ 无法访问麦克风: " + e.message, "error");
    return;
  }

  let mimeType = "";
  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of preferredTypes) {
    if (MediaRecorder.isTypeSupported(t)) {
      mimeType = t;
      break;
    }
  }
  if (!mimeType) {
    showVoiceStatus("❌ 您的浏览器不支持音频录制", "error");
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: mimeType });
    recordedAudioBlob = blob;
    recordedAudioMimeType = mimeType.split(";")[0];
    recordedAudioBase64 = await blobToBase64(blob);
    elVoiceAudio.src = URL.createObjectURL(blob);
    elVoicePreview.hidden = false;
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  };
  mediaRecorder.start(1000);

  recordStartTime = Date.now();
  recordTimerHandle = setInterval(updateRecordDuration, 200);
  updateRecordDuration();

  isRecording = true;
  elVoiceBtn.classList.add("recording");
  elVoiceBtn.textContent = "⏹️";

  if (initSpeechRecognition()) {
    try {
      recognition.start();
    } catch (e) {
      showVoiceStatus("🎤 正在录音...（语音转文字不可用，但录音会保存）");
    }
  } else {
    showVoiceStatus("🎤 正在录音...（浏览器不支持实时转文字，但录音会保存）");
  }
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  elVoiceBtn.classList.remove("recording");
  elVoiceBtn.textContent = "🎤";
  if (recordTimerHandle) {
    clearInterval(recordTimerHandle);
    recordTimerHandle = null;
  }

  const stopped = new Promise((resolve) => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        recordedAudioBlob = blob;
        recordedAudioMimeType = mediaRecorder.mimeType.split(";")[0];
        recordedAudioBase64 = await blobToBase64(blob);
        elVoiceAudio.src = URL.createObjectURL(blob);
        elVoicePreview.hidden = false;
        if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
        resolve();
      };
      mediaRecorder.stop();
    } else {
      resolve();
    }
  });
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
  }
  await stopped;

  const duration = Date.now() - recordStartTime;
  elVoiceDuration.textContent = "⏱️ " + formatDuration(duration);
}

elVoiceBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

elVoiceDiscard.addEventListener("click", () => {
  clearRecordedAudio();
  showVoiceStatus("🗑️ 已丢弃录音", "info");
  setTimeout(hideVoiceStatus, 1500);
});

elManualInputDialog.addEventListener("close", () => {
  if (isRecording) stopRecording();
  hideVoiceStatus();
});

// ========== 本地答题校验（仍保留，作为快速反馈） ==========
function normalize(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/，/g, ",");
}
function checkCorrect(u, c) {
  const U = normalize(u),
    C = normalize(c);
  if (U === C) return true;
  const un = parseFloat(U),
    cn = parseFloat(C);
  if (!isNaN(un) && !isNaN(cn) && Math.abs(un - cn) < 1e-6) return true;
  if (U.includes(C) || C.includes(U)) return true;
  return false;
}
function submitAnswer() {
  const userAns = elFinalAnswer.value;
  if (!userAns.trim()) {
    alert("请先输入答案");
    return;
  }
  // 直接交给 agent 评判，由 AI 用工具判答 + 鼓励
  addUserMsg(`我的答案是：${userAns}`);
  runTurn(
    `请用工具 check_answer 判断我的答案"${userAns}"是否正确，然后记录到我的历史，并给我反馈。如果错了请给我提示，不要直接告诉我答案。`,
  );
}

// ========== 设置弹窗 ==========
const dlg = $("#settings-dialog");
$("#settings-btn").addEventListener("click", () => dlg.showModal());

// ========== 模式切换（学生版 / 家长版）==========
function setModeUI(mode) {
  state.mode = mode;
  localStorage.setItem("ai_mode", mode);
  document
    .querySelectorAll(".mode-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}
document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    if (mode === state.mode || state.turnInFlight) return;
    setModeUI(mode);
    // 切换模式 = 重建会话（系统提示不同），清空当前对话
    elChatLog.innerHTML = "";
    addSystemMsg(
      mode === "parent"
        ? "🔁 已切换到「家长版」。你可以让我识别题目、给辅导思路、分析孩子错因；我会更主动地讲解。"
        : "🔁 已切换到「学生版」。我不会主动分析题目或给思路，只有你提问时才回答——自己先想想看吧。",
    );
    try {
      await createSession(mode);
    } catch (e) {
      addErrorMsg("重建会话失败: " + e.message);
    }
  });
});
setModeUI(state.mode);

// ========== 事件 ==========
$("#prev-problem").addEventListener("click", () => {
  state.idx = (state.idx - 1 + state.problems.length) % state.problems.length;
  renderProblem();
});
$("#next-problem").addEventListener("click", () => {
  state.idx = (state.idx + 1) % state.problems.length;
  renderProblem();
});
$("#delete-problem").addEventListener("click", async () => {
  const p = state.problems[state.idx];
  if (!p) return;
  if (state.turnInFlight) {
    addSystemMsg("⏳ AI 正在处理中，请稍候再删除题目。");
    return;
  }
  if (
    !confirm(
      `确定删除当前题目「${p.topic || ""} · ${(p.text || "").slice(0, 24)}…」吗？`,
    )
  )
    return;
  const deletedIdx = state.idx;
  const deletedId = p.id;
  try {
    const resp = await fetch("/api/problem/" + encodeURIComponent(p.id), {
      method: "DELETE",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    await loadProblems();
    addSystemMsg(`🗑️ 已删除题目 ${deletedId}。`);
    if (!state.problems.length) {
      addSystemMsg("题库已空。可以让 AI 出一道新题。");
      state.idx = 0;
    } else {
      const wantId = data.current_problem_id || state.problems[0].id;
      const found = state.problems.findIndex((pp) => pp.id === wantId);
      state.idx = found >= 0 ? found : Math.min(deletedIdx, state.problems.length - 1);
    }
    renderProblem();
    await createSession(state.mode);
    addSystemMsg(`💬 新对话已开启（历史记录已保留）。`);
  } catch (e) {
    addErrorMsg("删除失败: " + e.message);
  }
});
$("#check-answer").addEventListener("click", submitAnswer);
$("#chat-send").addEventListener("click", () => {
  const text = elChatInput.value.trim();
  if (!text) return;
  addUserMsg(text);
  elChatInput.value = "";
  runTurn(text);
});
elChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#chat-send").click();
});
document.querySelectorAll(".quick").forEach((btn) => {
  btn.addEventListener("click", () => {
    const prompt = btn.dataset.prompt;
    addUserMsg(prompt);
    runTurn(prompt);
  });
});

// ========== 启动 ==========
window.addEventListener("resize", resizeCanvas);
window.addEventListener("load", async () => {
  resizeCanvas();
  initMarked();
  try {
    await loadProblems();
  } catch (e) {
    addErrorMsg("加载题库失败: " + e.message);
    return;
  }
  const params = new URLSearchParams(location.search);
  const startIdx = parseInt(params.get("p") || "0", 10);
  if (!isNaN(startIdx) && startIdx >= 0 && startIdx < state.problems.length) {
    state.idx = startIdx;
  }
  renderProblem();
  try {
    await createSession(state.mode);
    addSystemMsg(
      state.mode === "parent"
        ? `👋 欢迎（家长版）！Claude Code session 已创建。我可以主动分析题目、给辅导思路，帮你引导孩子。`
        : `👋 欢迎（学生版）！Claude Code session 已创建。我不会主动给你思路，自己先想；有问题再问我。`,
    );
  } catch (e) {
    addErrorMsg("创建会话失败: " + e.message);
  }
});
