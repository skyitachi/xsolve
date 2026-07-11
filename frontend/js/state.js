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

// ========== 按角色持久化 session ID ==========
// 每个角色（student/parent）独立维护一个 sessionId
// 切换角色时从 localStorage 读取目标角色的 sessionId

function saveSessionId(id, mode) {
  const m = mode || state.mode;
  if (id) {
    localStorage.setItem("xsolve_session_" + m, id);
  } else {
    localStorage.removeItem("xsolve_session_" + m);
  }
}

function getSavedSessionId(mode) {
  const m = mode || state.mode;
  return localStorage.getItem("xsolve_session_" + m) || null;
}

// 获取所有角色的 session ID 映射
function getAllSavedSessionIds() {
  return {
    student: localStorage.getItem("xsolve_session_student"),
    parent: localStorage.getItem("xsolve_session_parent"),
  };
}
