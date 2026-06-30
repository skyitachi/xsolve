// ========== 状态 ==========
const state = {
  problems: window.PROBLEMS,
  idx: 0,
  history: JSON.parse(localStorage.getItem('practice_history') || '[]'),
  chatMessages: [],
  apiKey: localStorage.getItem('sf_api_key') || '',
  model: localStorage.getItem('sf_model') || 'Qwen/Qwen2.5-7B-Instruct',
  baseUrl: localStorage.getItem('sf_base_url') || 'https://api.siliconflow.cn/v1',
  scratchStrokes: [],
};

function saveHistory() {
  // 仅保留最近 50 条，避免无限增长
  state.history = state.history.slice(-50);
  localStorage.setItem('practice_history', JSON.stringify(state.history));
}

// ========== DOM ==========
const $ = (sel) => document.querySelector(sel);
const elProblemContent = $('#problem-content');
const elProblemFigure = $('#problem-figure');
const elProblemIndex = $('#problem-index');
const elProblemTopic = $('#problem-topic');
const elFinalAnswer = $('#final-answer');
const elChatLog = $('#chat-log');
const elChatInput = $('#chat-input');
const elChatSend = $('#chat-send');
const elCanvas = $('#scratch');
const ctx = elCanvas.getContext('2d');

// ========== 渲染题目 ==========
function renderProblem() {
  const p = state.problems[state.idx];
  elProblemIndex.textContent = `${state.idx + 1} / ${state.problems.length}`;
  elProblemTopic.textContent = p.topic;
  elProblemContent.innerHTML = escapeAndKeepMath(p.text);
  if (window.renderMathInElement) {
    renderMathInElement(elProblemContent, {
      delimiters: [{ left: '$', right: '$', display: false }],
      throwOnError: false
    });
  }
  // 图形
  elProblemFigure.innerHTML = '';
  if (p.figure) renderFigure(p.figure, elProblemFigure);
  // 已答案
  elFinalAnswer.value = '';
  // 清空草稿
  clearCanvas();
  // 重置对话（保留历史摘要在系统提示中）
  state.chatMessages = [];
  elChatLog.innerHTML = '';
  addSystemMsg(`已切换到第 ${state.idx + 1} 题：${p.topic}。试着先自己想一想，需要时点上方按钮或直接提问。`);
}

function escapeAndKeepMath(text) {
  // 简单转义：先转 HTML，再保留 $...$
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== 图形渲染（简易 SVG）==========
function renderFigure(fig, container) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 320 220');
  svg.setAttribute('width', '92%');
  svg.setAttribute('height', '92%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  if (fig.type === 'rect') {
    const scale = Math.min(180 / fig.width, 130 / fig.height);
    const w = fig.width * scale, h = fig.height * scale;
    const x = (320 - w) / 2 + 20, y = (220 - h) / 2 + 10;
    addEl(svg, svgNS, 'rect', { x, y, width: w, height: h, fill: '#dbeafe', stroke: '#1d4ed8', 'stroke-width': 2 });
    addText(svg, svgNS, x + w / 2, y - 8, `长 ${fig.width} ${fig.unit || ''}`);
    addText(svg, svgNS, x - 6, y + h / 2 + 4, `宽 ${fig.height}${fig.unit || ''}`, 'end');
  } else if (fig.type === 'right-triangle') {
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
function addText(parent, ns, x, y, text, anchor = 'middle') {
  const t = document.createElementNS(ns, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('font-size', '13'); t.setAttribute('fill', '#374151');
  t.textContent = text;
  parent.appendChild(t);
  return t;
}

// 可拖拽直角三角形：直角顶点固定在原点，两条直角边的端点可拖动（约束在水平/竖直方向）
function renderInteractiveTriangle(svg, ns, fig) {
  const scale = 28;
  let a = fig.a, b = fig.b;
  const rightCorner = { x: 80, y: 180 };
  const polygon = addEl(svg, ns, 'polygon', { points: '', fill: '#fde68a', stroke: '#b45309', 'stroke-width': 2 });
  const rightMark = addEl(svg, ns, 'rect', { width: 12, height: 12, fill: 'none', stroke: '#b45309', 'stroke-width': 1.5 });
  const labelA = addText(svg, ns, 0, 0, '', 'end');
  const labelB = addText(svg, ns, 0, 0, '', 'middle');
  const labelC = addText(svg, ns, 0, 0, '', 'middle');
  labelC.setAttribute('fill', '#6d28d9');
  const handleA = addEl(svg, ns, 'circle', { r: 7, fill: '#4f46e5', stroke: 'white', 'stroke-width': 2, style: 'cursor:ns-resize' });
  const handleB = addEl(svg, ns, 'circle', { r: 7, fill: '#4f46e5', stroke: 'white', 'stroke-width': 2, style: 'cursor:ew-resize' });
  const hint = addText(svg, ns, 160, 18, '👆 拖动蓝点改变三角形');
  hint.setAttribute('fill', '#9ca3af');

  function redraw() {
    const ap = { x: rightCorner.x, y: rightCorner.y - a * scale };
    const bp = { x: rightCorner.x + b * scale, y: rightCorner.y };
    polygon.setAttribute('points', `${rightCorner.x},${rightCorner.y} ${bp.x},${bp.y} ${ap.x},${ap.y}`);
    rightMark.setAttribute('x', rightCorner.x);
    rightMark.setAttribute('y', rightCorner.y - 12);
    labelA.setAttribute('x', rightCorner.x - 8);
    labelA.setAttribute('y', (rightCorner.y + ap.y) / 2);
    labelA.textContent = `a = ${a}`;
    labelB.setAttribute('x', (rightCorner.x + bp.x) / 2);
    labelB.setAttribute('y', rightCorner.y + 18);
    labelB.textContent = `b = ${b}`;
    const c = Math.sqrt(a * a + b * b);
    labelC.setAttribute('x', (ap.x + bp.x) / 2 + 12);
    labelC.setAttribute('y', (ap.y + bp.y) / 2 - 4);
    labelC.textContent = `c = ${c.toFixed(2)}`;
    handleA.setAttribute('cx', ap.x); handleA.setAttribute('cy', ap.y);
    handleB.setAttribute('cx', bp.x); handleB.setAttribute('cy', bp.y);
  }
  redraw();

  function svgPos(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  let dragging = null;
  function down(which) { return (e) => { dragging = which; e.preventDefault(); }; }
  handleA.addEventListener('mousedown', down('a'));
  handleB.addEventListener('mousedown', down('b'));
  handleA.addEventListener('touchstart', down('a'), { passive: false });
  handleB.addEventListener('touchstart', down('b'), { passive: false });
  function moveSvg(e) {
    if (!dragging) return;
    e.preventDefault();
    const evt = e.touches ? e.touches[0] : e;
    const p = svgPos(evt);
    if (dragging === 'a') {
      const newA = Math.max(1, Math.round((rightCorner.y - p.y) / scale));
      a = Math.min(10, newA);
    } else {
      const newB = Math.max(1, Math.round((p.x - rightCorner.x) / scale));
      b = Math.min(10, newB);
    }
    redraw();
  }
  function up() { dragging = null; }
  svg.addEventListener('mousemove', moveSvg);
  window.addEventListener('mouseup', up);
  svg.addEventListener('touchmove', moveSvg, { passive: false });
  window.addEventListener('touchend', up);
}

// ========== 画布（草稿）==========
let drawing = false, tool = 'pen', lastX = 0, lastY = 0;
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = elCanvas.getBoundingClientRect();
  elCanvas.width = rect.width * dpr;
  elCanvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
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
  const p = pos(e); lastX = p.x; lastY = p.y;
  state.scratchStrokes.push([{ x: p.x, y: p.y }]);
}
function move(e) {
  if (!drawing) return;
  e.preventDefault();
  const p = pos(e);
  ctx.strokeStyle = tool === 'eraser' ? '#fffef6' : '#1f2937';
  ctx.lineWidth = tool === 'eraser' ? 18 : 2.4;
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  lastX = p.x; lastY = p.y;
  const stroke = state.scratchStrokes[state.scratchStrokes.length - 1];
  if (stroke) stroke.push({ x: p.x, y: p.y });
}
function end() { drawing = false; }
elCanvas.addEventListener('mousedown', start);
elCanvas.addEventListener('mousemove', move);
window.addEventListener('mouseup', end);
elCanvas.addEventListener('touchstart', start, { passive: false });
elCanvas.addEventListener('touchmove', move, { passive: false });
elCanvas.addEventListener('touchend', end);

document.querySelectorAll('.tool').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    if (t === 'clear') { clearCanvas(); return; }
    tool = t;
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === btn));
  });
});

// ========== 聊天 UI ==========
function addUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.textContent = text;
  elChatLog.appendChild(div);
  elChatLog.scrollTop = elChatLog.scrollHeight;
}
function addAiMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-ai';
  div.textContent = text;
  elChatLog.appendChild(div);
  if (window.renderMathInElement) {
    renderMathInElement(div, {
      delimiters: [{ left: '$', right: '$', display: false }, { left: '$$', right: '$$', display: true }],
      throwOnError: false
    });
  }
  elChatLog.scrollTop = elChatLog.scrollHeight;
  return div;
}
function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-system';
  div.textContent = text;
  elChatLog.appendChild(div);
  elChatLog.scrollTop = elChatLog.scrollHeight;
}

// ========== AI 调用 ==========
function buildSystemPrompt() {
  const p = state.problems[state.idx];
  const historySummary = state.history.length
    ? state.history.slice(-8).map(h => {
        const prob = state.problems.find(x => x.id === h.problemId);
        return `- [${h.topic || '?'}] 题目「${prob ? prob.text.slice(0, 28) : h.problemId}…」用户答 "${h.finalAnswer}"，${h.correct ? '✓正确' : '✗错误（正确：' + h.correctAnswer + '）'}`;
      }).join('\n')
    : '（无）';
  // 简单水平统计
  const stats = computeAbilityStats();
  const strokes = state.scratchStrokes.length;
  return `你是一位耐心、鼓励、循循善诱的小学数学老师。学生正在做下面这道题。请用小学生能懂的语言，不要直接给答案，先引导思考。当学生明显需要直接讲解时再给完整解答。回复使用简短中文，可使用 $...$ 写公式。

【当前题目】
主题: ${p.topic}
题面: ${p.text}
${p.figure ? '附带图形: ' + JSON.stringify(p.figure) : ''}
正确答案（仅供你参考，不要直接说出来除非学生已多次失败或主动要求）: ${p.answer}

【学生草稿区状态】
共 ${strokes} 笔；（暂未做手写识别，若学生让你"检查过程"，请询问他口述自己的思路。）

【学生历史做题记录（最近 8 条）】
${historySummary}

【学生水平简评（基于历史正确率）】
总做题数 ${stats.total}，正确率 ${stats.rate}%
按主题：${stats.byTopic.join('；') || '暂无'}

请始终用积极、鼓励的语气；不要嘲笑错误，把错误当作学习的机会。`;
}

function computeAbilityStats() {
  const total = state.history.length;
  if (!total) return { total: 0, rate: 0, byTopic: [] };
  const correct = state.history.filter(h => h.correct).length;
  const byTopicMap = {};
  for (const h of state.history) {
    const t = h.topic || '其他';
    byTopicMap[t] = byTopicMap[t] || { c: 0, t: 0 };
    byTopicMap[t].t++;
    if (h.correct) byTopicMap[t].c++;
  }
  const byTopic = Object.entries(byTopicMap).map(([t, v]) =>
    `${t} ${v.c}/${v.t} (${Math.round(v.c / v.t * 100)}%)`);
  return { total, rate: Math.round(correct / total * 100), byTopic };
}

async function callAI(userText) {
  if (!state.apiKey) {
    addSystemMsg('请先点击右上角 ⚙️ 设置你的 SiliconFlow API Key。');
    openSettings();
    return;
  }
  state.chatMessages.push({ role: 'user', content: userText });

  const placeholder = addAiMsg('思考中…');
  elChatSend.disabled = true;
  try {
    const url = state.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + state.apiKey
      },
      body: JSON.stringify({
        model: state.model,
        max_tokens: 1024,
        temperature: 0.5,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          ...state.chatMessages
        ]
      })
    });
    if (!resp.ok) {
      const errTxt = await resp.text();
      placeholder.textContent = '⚠️ AI 调用失败：' + errTxt.slice(0, 400);
      return;
    }
    const data = await resp.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const text = (msg && (msg.content || msg.reasoning_content)) || '(空回复)';
    placeholder.textContent = text;
    if (window.renderMathInElement) {
      renderMathInElement(placeholder, {
        delimiters: [{ left: '$', right: '$', display: false }, { left: '$$', right: '$$', display: true }],
        throwOnError: false
      });
    }
    state.chatMessages.push({ role: 'assistant', content: text });
  } catch (err) {
    placeholder.textContent = '⚠️ 网络错误：' + err.message;
  } finally {
    elChatSend.disabled = false;
  }
}

// ========== 提交答案与水平检测 ==========
function normalize(s) {
  return String(s || '').trim().replace(/\s+/g, '').replace(/，/g, ',');
}
function checkCorrect(userAnswer, correctAnswer) {
  const u = normalize(userAnswer);
  const c = normalize(correctAnswer);
  if (u === c) return true;
  // 数字宽松比较
  const un = parseFloat(u), cn = parseFloat(c);
  if (!isNaN(un) && !isNaN(cn) && Math.abs(un - cn) < 1e-6) return true;
  // 包含关系（用于"周长26厘米, 面积40平方厘米" 与 学生写法差异）
  if (u.includes(c) || c.includes(u)) return true;
  return false;
}

function submitAnswer() {
  const p = state.problems[state.idx];
  const userAns = elFinalAnswer.value;
  if (!userAns.trim()) { alert('请先输入答案'); return; }
  const correct = checkCorrect(userAns, p.answer);
  state.history.push({
    problemId: p.id,
    topic: p.topic,
    finalAnswer: userAns,
    correctAnswer: p.answer,
    correct,
    time: new Date().toISOString()
  });
  saveHistory();
  if (correct) {
    addSystemMsg(`🎉 正确！答案是 ${p.answer}。`);
  } else {
    addSystemMsg(`❌ 答案 "${userAns}" 还不对。试着让 AI 助教检查一下你的思路，或再想想？`);
  }
}

// ========== 设置弹窗 ==========
const dlg = $('#settings-dialog');
function openSettings() {
  $('#api-key-input').value = state.apiKey;
  $('#model-select').value = state.model;
  $('#base-url-input').value = state.baseUrl;
  dlg.showModal();
}
$('#settings-btn').addEventListener('click', openSettings);
$('#save-key').addEventListener('click', () => {
  state.apiKey = $('#api-key-input').value.trim();
  state.model = $('#model-select').value;
  state.baseUrl = $('#base-url-input').value.trim() || 'https://api.siliconflow.cn/v1';
  localStorage.setItem('sf_api_key', state.apiKey);
  localStorage.setItem('sf_model', state.model);
  localStorage.setItem('sf_base_url', state.baseUrl);
});

// ========== 事件绑定 ==========
$('#prev-problem').addEventListener('click', () => {
  state.idx = (state.idx - 1 + state.problems.length) % state.problems.length;
  renderProblem();
});
$('#next-problem').addEventListener('click', () => {
  state.idx = (state.idx + 1) % state.problems.length;
  renderProblem();
});
$('#check-answer').addEventListener('click', submitAnswer);
$('#chat-send').addEventListener('click', () => {
  const text = elChatInput.value.trim();
  if (!text) return;
  addUserMsg(text);
  elChatInput.value = '';
  callAI(text);
});
elChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    $('#chat-send').click();
  }
});
document.querySelectorAll('.quick').forEach(btn => {
  btn.addEventListener('click', () => {
    const prompt = btn.dataset.prompt;
    addUserMsg(prompt);
    callAI(prompt);
  });
});

// ========== 启动 ==========
window.addEventListener('resize', resizeCanvas);
window.addEventListener('load', () => {
  resizeCanvas();
  const params = new URLSearchParams(location.search);
  const startIdx = parseInt(params.get('p') || '0', 10);
  if (!isNaN(startIdx) && startIdx >= 0 && startIdx < state.problems.length) {
    state.idx = startIdx;
  }
  renderProblem();
  if (!state.apiKey) {
    addSystemMsg('👋 欢迎！点击右上角 ⚙️ 配置 SiliconFlow API Key 后即可与 AI 助教对话。');
  }
});
