// 草稿（手写演算）识别的公共解析/格式化工具。
//
// 单独成模块的原因：turnController（每轮自动识别并注入）与 mcp-tools（模型主动调
// recognize_scratch）都需要同一套解析与缓存格式，而 mcp-tools 被 session.js 依赖、
// session.js 又被 turnController 依赖 —— 若把工具函数放在 turnController 里再让
// mcp-tools 反向引用，会形成循环依赖。
import { SCRATCH_OCR_MAX_CHARS } from './config.js';

/**
 * 把草稿识别结果整理成可读文本（注入 prompt 与写入缓存共用同一份格式）。
 * 超长时按 SCRATCH_OCR_MAX_CHARS 截断，避免撑爆上下文。
 */
export function formatScratchForPrompt(parsed) {
  const p = parsed || {};
  const parts = [];
  if (p.summary) parts.push(`概述：${p.summary}`);
  const exprs = Array.isArray(p.expressions) ? p.expressions.filter(Boolean) : [];
  if (exprs.length) parts.push(`算式：${exprs.join('；')}`);
  if (p.text) parts.push(`文字：${p.text}`);
  if (p.final_answer !== null && p.final_answer !== undefined && String(p.final_answer).trim() !== '') {
    parts.push(`草稿上写的答案：${p.final_answer}`);
  }
  let out = parts.join('\n');
  if (out.length > SCRATCH_OCR_MAX_CHARS) {
    out = out.slice(0, SCRATCH_OCR_MAX_CHARS) + '…（已截断）';
  }
  return out;
}

/**
 * 解析视觉模型返回的草稿识别结果。
 * 模型偶尔用 markdown 代码块包裹 JSON，或干脆返回自然语言 —— 都要兜住。
 * 返回对象一定含 expressions / text / final_answer / confidence / summary 五个字段。
 */
export function parseScratchResult(rawText) {
  const cleaned = String(rawText || '')
    .replace(/```(?:json)?\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();
  try {
    const j = JSON.parse(cleaned);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch { /* 非 JSON，退化成纯文本 */ }
  return {
    expressions: [],
    text: cleaned,
    final_answer: null,
    confidence: 'low',
    summary: cleaned.slice(0, 200),
    // 标记「JSON 解析失败，退化成纯文本」，调用方可据此附上原始返回
    _fallback: true,
  };
}
