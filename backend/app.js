// Express app — 路由定义与中间件配置
import express from 'express';
import fs from 'node:fs';
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
  patchSession,
} from './controllers/sessionController.js';
import { handleTurn } from './controllers/turnController.js';
import {
  evalDashboard,
  evalTurns,
  getTurnScores,
  getSessionScores,
  triggerJudge,
  getSessionEvalScoresHandler,
  triggerSessionJudge,
  sessionEvalSummary,
  sessionEvalList,
  studentEvalSummary,
  studentEvalList,
  triggerStudentEval,
} from './controllers/evalController.js';
import {
  listPrompts,
  getPrompt,
  createPrompt,
  activatePrompt,
  deletePrompt,
  listRoles,
} from './controllers/promptController.js';
import {
  getSettings,
  updateSettings,
  testSettings,
} from './controllers/settingsController.js';
import {
  memoryOverview,
  memoryAttempts,
  memoryFacts,
  memoryConsolidate,
} from './controllers/memoryController.js';
import {
  register,
  login,
  logout,
  me,
  invite,
  invites,
  children,
  changePassword,
  guestLogin,
} from './controllers/authController.js';
import {
  familyChildren,
  familyChildSessions,
  createBindCode,
  listBindCodes,
  bindByCode,
  unbindChild,
  myInvites,
} from './controllers/familyController.js';
import {
  adminListUsers,
  adminGetUser,
  adminCreateUser,
  adminResetPassword,
  adminSetStatus,
  adminSetAdmin,
  adminPatchUser,
  adminDeleteUser,
  adminAuditLogs,
  adminPurgeGuests,
} from './controllers/adminController.js';
import {
  requireAuth,
  requireRole,
  requireAdmin,
  requireParentOf,
  resolveTargetStudent,
} from './middleware/auth.js';
import { getStartupLogs } from './startup-logs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const DIAGRAMS_DIR = path.join(__dirname, '..', 'diagrams');

export function createApp() {
  const app = express();

  // 中间件
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 静态文件（含 PWA：manifest 需正确的 MIME 类型）
  app.use(
    express.static(FRONTEND_DIR, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        }
        if (filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
        // 导出给手机安装的本地 CA：给对 MIME，iOS/Android 才会当成证书处理
        if (filePath.endsWith('.crt')) {
          res.setHeader('Content-Type', 'application/x-x509-ca-cert');
        }
      },
    }),
  );

  // JSXGraph 分步作图产物（由 generate_step_diagram 工具写入）
  fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });
  app.use('/diagrams', express.static(DIAGRAMS_DIR));

  // ========== 启动日志（调试用）==========
  app.get('/api/logs', (_req, res) => {
    res.json({ logs: getStartupLogs() });
  });

  // ========== 健康检查 ==========
  app.get('/healthz', healthCheck);
  app.get('/api/health', healthCheck);

  // ========== 认证（登录 / 注册 / 登出 / 当前用户）==========
  // 公开：注册 / 登录 / 游客试用；其余需登录
  app.post('/api/auth/register', register);
  app.post('/api/auth/login', login);
  app.post('/api/auth/guest', guestLogin);
  app.post('/api/auth/logout', requireAuth, logout);
  app.get('/api/auth/me', requireAuth, me);
  app.post('/api/auth/password', requireAuth, changePassword);
  // 家长专属：邀请码与学生绑定
  app.post('/api/auth/invite', requireAuth, requireRole('parent'), invite);
  app.get('/api/auth/invites', requireAuth, requireRole('parent'), invites);
  app.get('/api/children', requireAuth, requireRole('parent'), children);

  // ========== 家长与孩子（P1）==========
  app.get('/api/family/children', requireAuth, familyChildren);
  app.get('/api/family/children/:studentId/sessions', requireAuth, requireParentOf((req) => req.params.studentId), familyChildSessions);
  app.get('/api/family/bind-codes', requireAuth, listBindCodes);
  app.post('/api/family/bind-codes', requireAuth, createBindCode);
  app.post('/api/family/bind', requireAuth, requireRole('parent'), bindByCode);
  app.delete('/api/family/children/:studentId', requireAuth, requireParentOf((req) => req.params.studentId), unbindChild);
  app.get('/api/family/invites', requireAuth, requireRole('parent'), myInvites);

  // ========== 账号管理（P2，管理员）==========
  app.get('/api/admin/users', requireAuth, requireAdmin, adminListUsers);
  app.post('/api/admin/users', requireAuth, requireAdmin, adminCreateUser);
  app.get('/api/admin/users/:id', requireAuth, requireAdmin, adminGetUser);
  app.patch('/api/admin/users/:id', requireAuth, requireAdmin, adminPatchUser);
  app.post('/api/admin/users/:id/password', requireAuth, requireAdmin, adminResetPassword);
  app.post('/api/admin/users/:id/status', requireAuth, requireAdmin, adminSetStatus);
  app.post('/api/admin/users/:id/admin', requireAuth, requireAdmin, adminSetAdmin);
  app.delete('/api/admin/users/:id', requireAuth, requireAdmin, adminDeleteUser);
  app.get('/api/admin/audit', requireAuth, requireAdmin, adminAuditLogs);
  app.post('/api/admin/guests/purge', requireAuth, requireAdmin, adminPurgeGuests);

  // ========== 题目管理（需登录）==========
  app.get('/api/problems', requireAuth, listProblems);
  app.delete('/api/problem/:id', requireAuth, requireAdmin, removeProblem);

  // ========== 会话列表（需登录）==========
  app.get('/api/sessions', requireAuth, listSessions);

  // ========== 会话管理（需登录 + 归属校验在 controller 内）==========
  app.post('/api/session', requireAuth, createSessionHandler);
  app.get('/api/session/:id/history', requireAuth, getSessionHistory);
  app.get('/api/session/:id', requireAuth, getSessionOrRestore);
  app.delete('/api/session/:id', requireAuth, deleteSessionWithDb);
  app.post('/api/session/:id/clear', requireAuth, clearSession);
  app.post('/api/session/:id/reset', requireAuth, resetSessionHandler);
  app.post('/api/session/:id/archive', requireAuth, archiveSession);
  app.patch('/api/session/:id', requireAuth, patchSession);

  // ========== 草稿同步（需登录）==========
  app.post('/api/session/:id/scratch', requireAuth, syncScratch);
  app.post('/api/session/:id/scratch-image', requireAuth, syncScratchImage);

  // ========== 确认操作（需登录）==========
  app.post('/api/session/:id/delete-confirm', requireAuth, deleteConfirm);
  app.post('/api/session/:id/proposal', requireAuth, proposalConfirm);

  // ========== 对话 turn（SSE 流式，需登录）==========
  app.post('/api/session/:id/turn', requireAuth, handleTurn);

  // ========== 评估（管理员）==========
  app.get('/api/eval/dashboard', requireAuth, requireAdmin, evalDashboard);
  app.get('/api/eval/turns', requireAuth, requireAdmin, evalTurns);
  app.get('/api/eval/scores/turn/:turnId', requireAuth, requireAdmin, getTurnScores);
  app.get('/api/eval/scores/session/:sessionId', requireAuth, requireAdmin, getSessionScores);
  app.post('/api/eval/judge/:turnId', requireAuth, requireAdmin, triggerJudge);

  // session 级评估（管理员）
  app.get('/api/eval/session/:sessionId/scores', requireAuth, requireAdmin, getSessionEvalScoresHandler);
  app.post('/api/eval/session/:sessionId/judge', requireAuth, requireAdmin, triggerSessionJudge);
  app.get('/api/eval/session-summary', requireAuth, requireAdmin, sessionEvalSummary);
  app.get('/api/eval/sessions', requireAuth, requireAdmin, sessionEvalList);

  // 学生评估（管理员）
  app.get('/api/eval/student/summary', requireAuth, requireAdmin, studentEvalSummary);
  app.get('/api/eval/student/sessions', requireAuth, requireAdmin, studentEvalList);
  app.post('/api/eval/student/judge/:sessionId', requireAuth, requireAdmin, triggerStudentEval);

  // ========== Prompt 版本管理（管理员）==========
  app.get('/api/prompts', requireAuth, requireAdmin, listPrompts);
  app.get('/api/prompts/roles/list', requireAuth, requireAdmin, listRoles);
  app.get('/api/prompts/:id', requireAuth, requireAdmin, getPrompt);
  app.post('/api/prompts', requireAuth, requireAdmin, createPrompt);
  app.post('/api/prompts/:id/activate', requireAuth, requireAdmin, activatePrompt);
  app.delete('/api/prompts/:id', requireAuth, requireAdmin, deletePrompt);

  // ========== 运行时配置管理（管理员）==========
  app.get('/api/settings', requireAuth, requireAdmin, getSettings);
  app.put('/api/settings', requireAuth, requireAdmin, updateSettings);
  app.post('/api/settings/test', requireAuth, requireAdmin, testSettings);

  // ========== 学生记忆（学习档案页数据源）==========
  // 目标学生按账号角色解析：学生=自己；家长=已绑定孩子；管理员=须传 studentId
  const pickStudent = (req) =>
    req.query.studentId || req.query.student_id || req.body?.studentId || req.body?.student_id || null;
  app.get('/api/memory/overview', requireAuth, resolveTargetStudent(pickStudent), memoryOverview);
  app.get('/api/memory/attempts', requireAuth, resolveTargetStudent(pickStudent), memoryAttempts);
  app.get('/api/memory/facts', requireAuth, resolveTargetStudent(pickStudent), memoryFacts);
  app.post('/api/memory/consolidate', requireAuth, resolveTargetStudent(pickStudent), memoryConsolidate);

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
