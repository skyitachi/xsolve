// ========== 全局状态 ==========
var state = {
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

// session ID 持久化（刷新页面后恢复）
function saveSessionId(id) {
  if (id) localStorage.setItem("xsolve_session_id", id);
  else localStorage.removeItem("xsolve_session_id");
}
function getSavedSessionId() {
  return localStorage.getItem("xsolve_session_id") || null;
}
