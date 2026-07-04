// ========== 题目渲染与导航 ==========
var elProblemContent = $("#problem-content");
var elProblemFigure = $("#problem-figure");
var elProblemIndex = $("#problem-index");
var elProblemTopic = $("#problem-topic");

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

// ========== SVG 辅助函数 ==========
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

// ========== 加载题库 ==========
async function loadProblems() {
  const resp = await fetch("/api/problems");
  state.problems = await resp.json();
}

// ========== 题库变动后刷新 ==========
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

// ========== 题目导航：上一题/下一题 ==========
$("#prev-problem").addEventListener("click", () => {
  state.idx = (state.idx - 1 + state.problems.length) % state.problems.length;
  renderProblem();
});
$("#next-problem").addEventListener("click", () => {
  state.idx = (state.idx + 1) % state.problems.length;
  renderProblem();
});

// ========== 删除题目按钮 ==========
$("#delete-problem").addEventListener("click", () => {
  const p = state.problems[state.idx];
  if (!p) return;
  if (state.turnInFlight) {
    addSystemMsg("⏳ AI 正在处理中，请稍候再删除题目。");
    return;
  }
  // 使用统一的自定义删除确认弹窗
  showDeleteDialog({ id: p.id, topic: p.topic, text: p.text }, "manual");
});
