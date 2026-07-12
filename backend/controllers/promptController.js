// Prompt 版本管理 controller
import {
  listPromptVersions,
  getPromptVersion,
  insertPromptVersion,
  activatePromptVersion,
  deletePromptVersion,
  listPromptRoles,
} from '../db.js';

// GET /api/prompts?role=student
export function listPrompts(req, res) {
  const role = req.query.role;
  const rows = listPromptVersions(role);
  res.json(rows.map(r => ({
    id: r.id,
    role: r.role,
    version: r.version,
    description: r.description,
    is_active: !!r.is_active,
    content_length: r.content?.length || 0,
    content_preview: r.content?.slice(0, 100) || '',
    created_at: r.created_at,
  })));
}

// GET /api/prompts/:id — 获取完整内容
export function getPrompt(req, res) {
  const row = getPromptVersion(req.params.id);
  if (!row) return res.status(404).json({ error: 'prompt version not found' });
  res.json({
    id: row.id,
    role: row.role,
    version: row.version,
    content: row.content,
    description: row.description,
    is_active: !!row.is_active,
    created_at: row.created_at,
  });
}

// POST /api/prompts — 创建新版本
export function createPrompt(req, res) {
  const { role, content, description } = req.body || {};
  if (!role || !content) return res.status(400).json({ error: 'missing role or content' });
  const result = insertPromptVersion({ role, content, description });
  res.status(201).json(result);
}

// POST /api/prompts/:id/activate — 激活版本
export function activatePrompt(req, res) {
  const ok = activatePromptVersion(req.params.id);
  if (!ok) return res.status(404).json({ error: 'prompt version not found' });
  res.json({ ok: true, message: '版本已激活，新建会话将使用此 prompt' });
}

// GET /api/prompts/roles/list — 列出所有 prompt 角色
export function listRoles(req, res) {
  res.json(listPromptRoles());
}

// DELETE /api/prompts/:id — 删除版本（不允许删除活跃版本）
export function deletePrompt(req, res) {
  const result = deletePromptVersion(req.params.id);
  if (!result.ok) {
    const status = result.error === 'not found' ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }
  res.json({ ok: true, message: '版本已删除' });
}
