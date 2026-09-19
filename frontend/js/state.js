// ========== 全局状态 ==========
var state = {
  problems: [], // 从后端 /api/problems 拉取（不含答案）
  idx: 0,
  sessionId: null,
  userId: null, // 当前登录用户 id（由 js/auth.js 填充，用于隔离会话本地键）
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

// ========== 按「账号 + 角色」持久化 session ID ==========
// 每个账号的每个角色（student/parent）独立维护一个 sessionId，
// 避免同一浏览器切换账号时串会话。
// 键：xsolve_session_<userId>_<mode>；未登录/未知账号时回落到旧键 xsolve_session_<mode>。

function _sessionKey(mode) {
  const m = mode || state.mode;
  return state.userId
    ? "xsolve_session_" + state.userId + "_" + m
    : "xsolve_session_" + m;
}

function _legacySessionKey(mode) {
  return "xsolve_session_" + (mode || state.mode);
}

function saveSessionId(id, mode) {
  const key = _sessionKey(mode);
  if (id) {
    localStorage.setItem(key, id);
  } else {
    localStorage.removeItem(key);
    localStorage.removeItem(_legacySessionKey(mode));
  }
}

function getSavedSessionId(mode) {
  const key = _sessionKey(mode);
  const v = localStorage.getItem(key);
  if (v) return v;
  // 兼容升级前存下的旧键（引导账号可无缝续用历史会话）
  return localStorage.getItem(_legacySessionKey(mode)) || null;
}

// 获取所有角色的 session ID 映射
function getAllSavedSessionIds() {
  return {
    student: getSavedSessionId("student"),
    parent: getSavedSessionId("parent"),
  };
}
