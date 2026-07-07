// ========== 入口文件 ==========
// 共享 DOM 元素引用
var elChatInput = $("#chat-input");
var elFinalAnswer = $("#final-answer");

// ========== 模式切换（学生版 / 家长版）==========
function setModeUI(mode) {
  state.mode = mode;
  localStorage.setItem("ai_mode", mode);
  document
    .querySelectorAll(".mode-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

// ========== 应用初始化（所有模块加载完成后调用）==========
function initApp() {
  // Canvas 尺寸初始化
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // Markdown 初始化
  initMarked();

  // 模式 UI 初始化
  setModeUI(state.mode);

  // 模式切换按钮
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

  // 发送按钮
  elChatSend.addEventListener("click", () => {
    const text = elChatInput.value.trim();
    if (!text) return;
    addUserMsg(text);
    elChatInput.value = "";
    runTurn(text);
  });

  // Enter 发送消息；Shift+Enter 换行
  elChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      elChatSend.click();
    }
  });

  // 提交答案按钮
  document.querySelector("#check-answer").addEventListener("click", submitAnswer);

  // 快捷按钮
  document.querySelectorAll(".quick").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const prompt = btn.dataset.prompt;
      // "检查过程"按钮：引导AI调用recognize_scratch查看草稿
      if (prompt.includes("检查我刚才写在草稿区")) {
        if (state.scratchStrokes.length === 0) {
          addSystemMsg("📝 草稿板是空的，先写点演算过程再检查吧。");
          return;
        }
        if (state.turnInFlight) {
          addSystemMsg("⏳ AI正在处理中，请稍候...");
          return;
        }
        addUserMsg("🔍 请检查我的草稿过程");
        runTurn("请调用 recognize_scratch 工具识别我草稿板上的手写内容，仔细检查我的演算过程和答案是否正确。如果有错误，请用提问的方式引导我发现问题，不要直接告诉我正确答案。");
        return;
      }
      addUserMsg(prompt);
      runTurn(prompt);
    });
  });

  // 清空对话历史（保留 session ID，类似 /clear）
  document.querySelector("#btn-clear-history").addEventListener("click", async () => {
    if (state.turnInFlight) {
      addSystemMsg("⏳ AI正在处理中，请稍候再清空。");
      return;
    }
    if (!state.sessionId) {
      addSystemMsg("⚠️ 当前没有活跃会话。");
      return;
    }
    try {
      AiStatus.begin("正在清空历史…");
      await clearChatHistory();
      elChatLog.innerHTML = "";
      addSystemMsg("🧹 对话历史已清空（会话保留，可继续对话）。");
      AiStatus.done();
    } catch (e) {
      addErrorMsg("清空历史失败: " + e.message);
      AiStatus.error(e.message);
    }
  });

  // 新建对话（覆盖老 session，创建新 session）
  document.querySelector("#btn-new-chat").addEventListener("click", async () => {
    if (state.turnInFlight) {
      addSystemMsg("⏳ AI正在处理中，请稍候再新建对话。");
      return;
    }
    if (!state.sessionId) {
      addSystemMsg("⚠️ 当前没有活跃会话。");
      return;
    }
    try {
      AiStatus.begin("正在新建对话…");
      await newChatOverride();
      elChatLog.innerHTML = "";
      addSystemMsg("✨ 新对话已开启（旧会话已覆盖）。");
      AiStatus.done();
    } catch (e) {
      addErrorMsg("新建对话失败: " + e.message);
      AiStatus.error(e.message);
    }
  });

  // 启动：加载题库、恢复或创建会话
  (async function boot() {
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

    // 尝试恢复上次的 session（刷新页面场景）
    const savedSid = getSavedSessionId();
    if (savedSid) {
      try {
        const restored = await restoreSession(savedSid);
        if (restored) {
          // 同步模式
          if (restored.mode && restored.mode !== state.mode) {
            setModeUI(restored.mode);
          }
          addSystemMsg("🔄 已恢复上次对话（session 保留中）。");
          return;
        }
      } catch {
        // session 已失效，清除旧 ID 并新建
        saveSessionId(null);
      }
    }

    // 新建 session
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
  })();
}

// ========== 启动 ==========
// 使用 DOMContentLoaded 确保 <head> 中 defer 的 CDN 脚本（marked、katex）已加载完成
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
