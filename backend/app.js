// Express app — 路由定义与中间件配置
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Controllers
import { healthCheck } from './controllers/healthController.js';
import { listProblems, removeProblem } from './controllers/problemController.js';
import {
  createSessionHandler,
  getSession,
  getSessionOrRestore,
  deleteSession,
  deleteSessionWithDb,
  clearSession,
  resetSessionHandler,
  syncScratch,
  syncScratchImage,
  deleteConfirm,
  proposalConfirm,
  listSessions,
  getSessionHistory,
  archiveSession,
} from './controllers/sessionController.js';
import { handleTurn } from './controllers/turnController.js';
import {
  evalDashboard,
  getTurnScores,
  getSessionScores,
  triggerJudge,
} from './controllers/evalController.js';
import {
  listPrompts,
  getPrompt,
  createPrompt,
  activatePrompt,
  deletePrompt,
  listRoles,
} from './controllers/promptController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

export function createApp() {
  const app = express();

  // 中间件
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 静态文件
  app.use(express.static(FRONTEND_DIR));

  // ========== 健康检查 ==========
  app.get('/healthz', healthCheck);
  app.get('/api/health', healthCheck);

  // ========== 题目管理 ==========
  app.get('/api/problems', listProblems);
  app.delete('/api/problem/:id', removeProblem);

  // ========== 会话列表 ==========
  app.get('/api/sessions', listSessions);

  // ========== 会话管理 ==========
  app.post('/api/session', createSessionHandler);
  app.get('/api/session/:id/history', getSessionHistory);
  app.get('/api/session/:id', getSessionOrRestore);
  app.delete('/api/session/:id', deleteSessionWithDb);
  app.post('/api/session/:id/clear', clearSession);
  app.post('/api/session/:id/reset', resetSessionHandler);
  app.post('/api/session/:id/archive', archiveSession);

  // ========== 草稿同步 ==========
  app.post('/api/session/:id/scratch', syncScratch);
  app.post('/api/session/:id/scratch-image', syncScratchImage);

  // ========== 确认操作 ==========
  app.post('/api/session/:id/delete-confirm', deleteConfirm);
  app.post('/api/session/:id/proposal', proposalConfirm);

  // ========== 对话 turn（SSE 流式） ==========
  app.post('/api/session/:id/turn', handleTurn);

  // ========== 评估 ==========
  app.get('/api/eval/dashboard', evalDashboard);
  app.get('/api/eval/scores/turn/:turnId', getTurnScores);
  app.get('/api/eval/scores/session/:sessionId', getSessionScores);
  app.post('/api/eval/judge/:turnId', triggerJudge);

  // ========== Prompt 版本管理 ==========
  app.get('/api/prompts', listPrompts);
  app.get('/api/prompts/roles/list', listRoles);
  app.get('/api/prompts/:id', getPrompt);
  app.post('/api/prompts', createPrompt);
  app.post('/api/prompts/:id/activate', activatePrompt);
  app.delete('/api/prompts/:id', deletePrompt);

  // ========== 404 兜底 ==========
  app.use((req, res) => {
    res.status(404).json({ error: 'not found', path: req.path });
  });

  // ========== 全局错误处理 ==========
  app.use((err, req, res, _next) => {
    console.error('[express] error:', err);
    res.status(500).json({ error: err.message || 'internal server error' });
  });

  return app;
}
