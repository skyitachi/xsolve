#!/usr/bin/env node
// 小学 AI 做题助手 后端入口
// 模块拆分：
//   config.js   - 配置、常量、系统提示词
//   utils.js    - 通用工具函数
//   vision.js   - 视觉识别子代理
//   mcp-tools.js - MCP 工具集（题目/答题/草稿/计算/视觉）
//   session.js  - Session 管理、SDK query 实例
//   routes.js   - HTTP API 路由
//   db.js       - SQLite 数据库操作（已有）
//   problems.js - 内置题库数据（已有）

import http from 'node:http';
import { PORT, VISION_MODEL } from './config.js';
import { sessions, destroySession } from './session.js';
import { handleRequest } from './routes.js';
import { send } from './utils.js';

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[selflearning] http://localhost:${PORT}`);
  console.log(`[selflearning] auth source = ANTHROPIC_API_KEY env / claude CLI login`);
  let warn = '';
  const ml = VISION_MODEL.toLowerCase();
  if (ml.includes('embedding')) {
    warn = '  ⚠️  名称含 "Embedding"，嵌入模型无法做图像识别，请用 VISION_MODEL 指定视觉对话模型（如 Qwen/Qwen3-VL-8B-Instruct）';
  } else if (ml.includes('thinking')) {
    warn = '  ⚠️  名称含 "Thinking"，推理模型会产生大量思考 token，建议改用非 thinking 版本（如 Qwen/Qwen3-VL-8B-Instruct）';
  }
  console.log(`[selflearning] vision model = ${VISION_MODEL}${warn}`);
});

process.on('SIGINT', async () => {
  console.log('shutting down...');
  for (const s of sessions.values()) await destroySession(s);
  process.exit(0);
});
