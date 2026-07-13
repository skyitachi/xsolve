// ========== 聊天系统 ==========
var elChatLog = $("#chat-log");
var elChatSend = $("#chat-send");

// ========== 消息渲染 ==========
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

function addSystemMsg(text) {
  const div = document.createElement("div");
  div.className = "msg msg-system md-content";
  div.innerHTML = renderMarkdown(text, { escape: false });
  elChatLog.appendChild(div);
  renderMathInMsg(div);
  scrollChat();
}

function addErrorMsg(text) {
  const div = document.createElement("div");
  div.className = "msg msg-error";
  const icon = document.createElement("div");
  icon.className = "error-icon";
  icon.textContent = "\u26A0\uFE0F";
  const body = document.createElement("div");
  body.className = "error-body";
  const title = document.createElement("div");
  title.className = "error-title";
  title.textContent = "出错了";
  const content = document.createElement("div");
  content.className = "error-content";
  content.textContent = text;
  body.appendChild(title);
  body.appendChild(content);
  div.appendChild(icon);
  div.appendChild(body);
  elChatLog.appendChild(div);
  scrollChat();
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

function scrollChat() {
  if (window._diagramDragging || window._panelResizing) return;
  elChatLog.scrollTop = elChatLog.scrollHeight;
}

// ========== AI 状态指示器 ==========
var elStatus = $("#ai-status");
var elStatusText = elStatus.querySelector(".status-text");
var elStatusTimer = elStatus.querySelector(".status-timer");
var AiStatus = {
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

// ========== 工具调用卡片 ==========
var TOOL_LABELS = {
  list_problems: "📚 列出题库",
  get_current_problem: "📖 读取当前题",
  get_problem: "📖 读取题目",
  set_current_problem: "🔀 切换题目",
  delete_problem: "🗑️ 删除题目",
  propose_problem: "🎯 出新题",
  recognize_problem_image: "👁️ 视觉子代理识别",
  recognize_scratch: "👁️ 识别草稿笔迹",
  check_answer: "✅ 判答",
  record_history: "💾 记录历史",
  ability_report: "📊 水平评估",
  read_scratch_state: "🖊️ 检查草稿",
  calc: "🧮 计算",
  generate_step_diagram: "📐 分步作图",
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

// ========== 会话管理 ==========

// 创建新会话（绑定角色）
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
  saveSessionId(data.id, state.mode);
  return data;
}

// 恢复已有 session（刷新页面或切换角色时用）
// 先尝试从内存恢复（GET /api/session/:id 会自动触发后端 restoreSession）
async function restoreSession(sid) {
  const resp = await fetch(`/api/session/${sid}`, { method: "GET" });
  if (!resp.ok) return null;
  const data = await resp.json();
  state.sessionId = data.id;
  state.mode = data.mode || state.mode;
  saveSessionId(data.id, state.mode);
  return data;
}

// 加载会话历史并渲染到聊天界面
async function loadSessionHistory(sid) {
  try {
    const resp = await fetch(`/api/session/${sid}/history`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.turns && data.turns.length > 0) {
      for (const turn of data.turns) {
        if (turn.userMessage) {
          addUserMsg(turn.userMessage);
        }
        if (turn.aiMessage) {
          addAiMsg(turn.aiMessage);
        }
      }
    }
  } catch (e) {
    console.warn("加载历史失败:", e.message);
  }
}

// 清空当前会话历史（保留 session ID，类似 /clear）
async function clearChatHistory() {
  if (!state.sessionId) return;
  const resp = await fetch(`/api/session/${state.sessionId}/clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!resp.ok) throw new Error("清空历史失败: " + resp.status);
  const data = await resp.json();
  // session ID 不变，但 SDK 进程已重置
  return data;
}

// 新建会话覆盖老会话（销毁旧 session，创建新 session）
async function newChatOverride() {
  const oldId = state.sessionId;
  const resp = await fetch(`/api/session/${oldId}/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: state.mode }),
  });
  if (!resp.ok) throw new Error("新建对话失败: " + resp.status);
  const data = await resp.json();
  state.sessionId = data.id;
  state.mode = data.mode || state.mode;
  saveSessionId(data.id, state.mode);
  return data;
}

// ========== SSE 流式处理 ==========
var _abortController = null;

async function cancelTurn() {
  if (!state.turnInFlight) return;
  // 1. 前端中止 fetch reader
  if (_abortController) {
    try { _abortController.abort(); } catch {}
  }
  // 2. 后端中止 SDK 查询
  if (state.sessionId) {
    try {
      await fetch(`/api/session/${state.sessionId}/abort`, { method: "POST" });
    } catch {}
  }
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
  elChatSend.style.display = "none";
  $("#chat-cancel").style.display = "";
  elChatSend.disabled = true;
  let streamDone = false;
  let streamAborted = false;
  _abortController = new AbortController();
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
      signal: _abortController.signal,
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
    await readSSE(resp.body, () => { streamDone = true; }, () => { streamAborted = true; });
    if (streamAborted) {
      addSystemMsg("⏹️ 已取消当前回复。");
      AiStatus.done();
    } else if (!streamDone) {
      addErrorMsg("连接异常中断：AI 未返回完整结果，请重试。");
      AiStatus.error("连接中断");
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      addSystemMsg("⏹️ 已取消当前回复。");
      AiStatus.done();
    } else {
      addErrorMsg(`网络/系统错误：\n${e.message || String(e)}`);
      AiStatus.error(e.message || "网络错误");
    }
  } finally {
    state.turnInFlight = false;
    elChatSend.disabled = false;
    elChatSend.style.display = "";
    $("#chat-cancel").style.display = "none";
    _abortController = null;
  }
}

async function readSSE(stream, onDone, onAborted) {
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
      if (event === "aborted" && onAborted) onAborted();
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
    case "aborted":
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

// ========== SDK 消息处理 ==========
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
  } else if (ev.type === "content_block_deltas_batch") {
    // 批量 delta：一次处理多个 content_block_delta，减少 DOM 操作和 scrollChat 调用
    const deltas = ev.deltas || [];
    let hasText = false;
    for (const item of deltas) {
      const block = st.blocks && st.blocks[item.index];
      if (!block) continue;
      const d = item.delta || {};
      if (block.type === "text" && d.type === "text_delta" && d.text) {
        block.rawBuf += d.text;
        hasText = true;
      } else if (
        block.type === "tool_use" &&
        d.type === "input_json_delta" &&
        d.partial_json
      ) {
        block.jsonBuf += d.partial_json;
        const card = toolCards[block.cardId];
        if (card) card.querySelector(".tool-args").textContent = block.jsonBuf;
      }
    }
    // 只渲染一次 + 滚动一次，而非每个 delta 都渲染
    if (hasText && st.activeTextDiv) {
      for (const k in st.blocks) {
        const b = st.blocks[k];
        if (b && b.type === "text" && b.div === st.activeTextDiv) {
          renderAiBlock(b, false);
          break;
        }
      }
      scrollChat();
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

// ========== UI 事件处理（来自后端）==========
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
  } else if (ev.type === "delete_proposed") {
    showDeleteDialog(ev.problem, "ai");
  } else if (ev.type === "problems_changed") {
    // 题库变动（删除/新增），重新拉取并定位
    refreshProblemsAfterChange(ev.current_problem_id, ev.deleted_id);
  } else if (ev.type === "vision_subagent_started") {
    AiStatus.tick(`视觉子代理识别中（${ev.model || "vision"}）…`, "tool");
  } else if (ev.type === "vision_subagent_done") {
    AiStatus.tick("视觉子代理完成，主代理继续…", "thinking");
  } else if (ev.type === "scratch_recognition_started") {
    AiStatus.tick(`正在识别草稿笔迹（${ev.model || "vision"}）…`, "tool");
  } else if (ev.type === "scratch_recognition_done") {
    AiStatus.tick("草稿识别完成，AI 分析中…", "thinking");
  } else if (ev.type === "diagram_generated") {
    showDiagramCard(ev.url, ev.title);
  }
}

// 在聊天里插入一个 JSXGraph 分步作图卡片（内嵌 iframe + 新窗口打开 + 拖拽调整大小）
function showDiagramCard(url, title) {
  const card = document.createElement("div");
  card.className = "msg msg-ai diagram-card";

  const head = document.createElement("div");
  head.className = "diagram-head";
  const icon = document.createElement("span");
  icon.textContent = "📐 ";
  const titleEl = document.createElement("span");
  titleEl.className = "diagram-title";
  titleEl.textContent = title || "分步作图";
  head.appendChild(icon);
  head.appendChild(titleEl);

  const openLink = document.createElement("a");
  openLink.className = "diagram-open";
  openLink.href = url;
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "在新窗口打开 ↗";
  head.appendChild(openLink);

  const frame = document.createElement("iframe");
  frame.className = "diagram-frame";
  frame.src = url;
  frame.title = title || "分步作图";
  frame.sandbox = "allow-scripts allow-same-origin";

  // ---- card 本身可拖拽改变大小，iframe 自适应填满 ----
  var minW = 280, maxW = 1200;
  var minH = 300, maxH = 1200;

  function makeHandle(dir) {
    var h = document.createElement("div");
    h.className = "diagram-resize-handle rz-" + dir;
    var hint = document.createElement("span");
    hint.className = "diagram-resize-hint";
    hint.textContent = dir === "se" ? "⇲ 拖拽调整大小" : (dir === "s" ? "⇅ 拖拽调整高度" : "⇄ 拖拽调整宽度");
    h.appendChild(hint);

    function start(e) {
      e.preventDefault();
      e.stopPropagation();
      window._diagramDragging = true;
      var startX = e.touches ? e.touches[0].clientX : e.clientX;
      var startY = e.touches ? e.touches[0].clientY : e.clientY;
      var startW = card.offsetWidth;
      var startH = card.offsetHeight;
      h.classList.add("dragging");
      card.classList.add("dragging");

      function onMove(ev) {
        ev.preventDefault();
        var cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
        var cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
        if (dir === "e" || dir === "se") {
          var newW = Math.max(minW, Math.min(maxW, startW + cx - startX));
          card.style.width = newW + "px";
          card.style.maxWidth = newW + "px";
        }
        if (dir === "s" || dir === "se") {
          var newH = Math.max(minH, Math.min(maxH, startH + cy - startY));
          card.style.height = newH + "px";
        }
      }

      function onEnd() {
        h.classList.remove("dragging");
        card.classList.remove("dragging");
        window._diagramDragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("mouseup", onEnd);
        document.removeEventListener("touchend", onEnd);
        document.removeEventListener("mouseleave", onEnd);
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("mouseup", onEnd);
      document.addEventListener("touchend", onEnd);
      document.addEventListener("mouseleave", onEnd);
    }

    h.addEventListener("mousedown", start);
    h.addEventListener("touchstart", start, { passive: false });
    return h;
  }

  var handleR = makeHandle("e");
  var handleB = makeHandle("s");
  var handleSE = makeHandle("se");

  card.appendChild(head);
  card.appendChild(frame);
  card.appendChild(handleR);
  card.appendChild(handleB);
  card.appendChild(handleSE);
  elChatLog.appendChild(card);
  scrollChat();
}

// ========== 本地答题校验 ==========
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
