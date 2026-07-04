// ========== DOM 工具函数 ==========
var $ = (sel) => document.querySelector(sel);
var $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
