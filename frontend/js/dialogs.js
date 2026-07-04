// ========== 弹窗系统 ==========

// ========== AI 出题确认弹窗 ==========
var elProposalDialog = $("#proposal-dialog");
var elProposalText = $("#proposal-text");
var elProposalTopic = $("#proposal-topic");
var elProposalHints = $("#proposal-hints");
var elProposalFigure = $("#proposal-figure");
var pendingProposal = null;

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

// ========== 统一删除确认弹窗（手动删除 + AI请求删除共用）==========
var elDeleteDialog = $("#delete-dialog");
var elDeleteTopic = $("#delete-topic");
var elDeleteText = $("#delete-text");
var elDeleteMsg = $("#delete-msg");
var pendingDelete = null; // { id, topic, preview, source: 'manual'|'ai' }

function showDeleteDialog(problem, source) {
  pendingDelete = {
    id: problem.id,
    topic: problem.topic || "题目",
    preview: problem.preview || (problem.text || "").slice(0, 200),
    source: source || "manual",
  };
  elDeleteTopic.textContent = pendingDelete.topic;
  // 正确渲染markdown和公式
  elDeleteText.classList.add("md-content");
  elDeleteText.innerHTML = renderMarkdown(problem.text || pendingDelete.preview, { escape: false });
  renderMathInMsg(elDeleteText);
  elDeleteMsg.textContent =
    source === "ai"
      ? "AI 助教请求删除这道题，删除后无法恢复。"
      : "删除后无法恢复，确定要删除这道题吗？";
  elDeleteDialog.showModal();
}

async function executeDelete(id) {
  try {
    const resp = await fetch("/api/problem/" + encodeURIComponent(id), { method: "DELETE" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json().catch(() => ({}));
    await loadProblems();
    addSystemMsg(`🗑️ 已删除题目。`);
    if (!state.problems.length) {
      addSystemMsg("题库已空。可以让 AI 出一道新题。");
      state.idx = 0;
    } else {
      const wantId = data.current_problem_id || (state.problems[0] && state.problems[0].id);
      const found = state.problems.findIndex((pp) => pp.id === wantId);
      state.idx = found >= 0 ? found : 0;
    }
    renderProblem();
    return true;
  } catch (err) {
    addErrorMsg("删除失败: " + err.message);
    return false;
  }
}

$("#delete-accept").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!pendingDelete) {
    elDeleteDialog.close();
    return;
  }
  const del = pendingDelete;
  elDeleteDialog.close();
  pendingDelete = null;
  const ok = await executeDelete(del.id);
  // 通知后端学生的决定（AI请求删除的场景需要）
  if (del.source === "ai" && state.sessionId) {
    try {
      await fetch(`/api/session/${state.sessionId}/delete-confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: ok ? "accept" : "cancel", problem_id: del.id }),
      });
    } catch {}
  }
});

$("#delete-cancel").addEventListener("click", async (e) => {
  e.preventDefault();
  const del = pendingDelete;
  elDeleteDialog.close();
  pendingDelete = null;
  if (del && del.source === "ai") {
    addSystemMsg("已取消删除操作。");
    if (state.sessionId) {
      try {
        await fetch(`/api/session/${state.sessionId}/delete-confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "cancel", problem_id: del.id }),
        });
      } catch {}
    }
  }
});

// ========== 手动输入题目弹窗 ==========
var elManualInputDialog = $("#manual-input-dialog");
var elManualInputText = $("#manual-input-text");

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

// ========== 设置弹窗 ==========
var elSettingsDialog = $("#settings-dialog");
$("#settings-btn").addEventListener("click", () => elSettingsDialog.showModal());
