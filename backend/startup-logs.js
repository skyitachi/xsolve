// 启动日志缓冲模块（不依赖其他模块，避免循环引用）
const logs = [];
const MAX = 500;

export function appendLog(level, msg) {
  logs.push({ ts: Date.now(), level, msg });
  if (logs.length > MAX) logs.shift();
}

export function getStartupLogs() {
  return [...logs];
}
