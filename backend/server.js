#!/usr/bin/env node
// 小学 AI 做题助手 后端 — 复用本地 Claude Code（@anthropic-ai/claude-agent-sdk）
// 每个浏览器 session 对应一个 query() 实例（流式输入模式），跨多轮持续。
// SDK 产生的 SDKMessage 通过 SSE 实时推给前端，UI 渲染 Claude-Code 风格的工具卡。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { getDb, getAllProblems, getProblem, insertProblem, updateProblemFigure, deleteProblem, getProblemsForClient } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8765', 10);
const STATIC_ROOT = path.resolve(__dirname, '..', 'frontend');

// ---------- 视觉子代理（识别题目图片）----------
// 主代理通常不具备视觉能力（如 glm-5.2 / kimi 等可能不看图），
// 因此图像识别交给一个独立 query() 子代理，用专门的视觉模型跑。
// 通过环境变量 VISION_MODEL 配置；默认按用户指定的 Qwen 视觉模型。
const VISION_MODEL = process.env.VISION_MODEL || 'Qwen/Qwen3-VL-8B-Instruct';
const VISION_MAX_TURNS = parseInt(process.env.VISION_MAX_TURNS || '2', 10);

const VISION_SUBAGENT_PROMPT = `你是一个专门做"数学题图片识别"的子代理（subagent）。你会收到一张小学数学题的图片。

任务：
1. 完整识别题面文字，保留数字、单位、标点。
2. 数学表达式用 LaTeX 包裹：行内用 $...$，如 $\\frac{2}{3}$、$3 \\times 4$、$x^2$。
3. 判断图片里是否含有和题目相关的图形（几何图、示意图、数轴、表格等）。
4. 不要解题、不要给答案、不要闲聊，只输出识别结果。
5. 禁止输出任何思考过程、推理过程、内部分析，直接按格式输出结果。绝对不要使用 <thinking>、<think> 标签或"让我分析"、"思考："等前缀。

严格按以下格式输出（每行一个字段）：
TOPIC: <主题分类，例如 鸡兔同笼 / 行程 / 几何-三角形 / 分数应用 / ...>
TEXT: <题面正文，含 $...$ LaTeX>
HAS_FIGURE: <true 或 false>
FIGURE_DESC: <若 HAS_FIGURE 为 true，用一句话描述图形；否则留空>

如果图片模糊、看不清关键数字，输出：
UNCLEAR: <哪部分看不清>
`;

// ---------- 会话注册表 ----------
// 每个 session 持有自己的 query() 实例 + 一个异步队列，作为流式输入的 prompt iterable。
// 用户发的每一条消息会推入队列；SDK 持续运行多轮直到我们 close()。
const sessions = new Map();

const SYSTEM_PROMPT_BASE = `你是一位耐心、鼓励的小学数学 AI 助教，借助 Claude Code 的工具能力辅导一位小学生（4-6 年级，学而思大白本风格）做数学题。

【你能用的工具（由 SDK 注入，名字以 mcp__tutor__ 开头）】
- get_current_problem: 读取学生当前正在做的题目（含正确答案，仅你可见）
- list_problems: 列出题库索引
- set_current_problem: 切换页面上正在显示的题目（学生说"换一题/下一题"时调用）
- delete_problem: 从题库删除一道题（学生说"删掉这题/不要这题"时调用），不传 id 则删当前题
- propose_problem: 当学生让你**出新题** / 出类似题 / 加深难度 时调用。你必须给出完整字段：topic, text (题面，可含 \\$...\\$ LaTeX), answer, hints[]，可选 figure。提交后会弹窗让学生确认是否替换当前题；用户确认前请不要假设题已经替换。
- check_answer: 判答（容错比较数字/分数/包含关系）
- record_history: 把一次提交记入学生历史
- ability_report: 输出基于历史的水平摘要
- read_scratch_state: 查看学生草稿区笔画数
- calc: 安全计算数学表达式（+ - * / 与括号），用它来避免心算出错
- recognize_problem_image: **识别题目图片专用**。你（主代理）看不到图片内容，当学生上传题目图片时必须调用此工具，它会启动一个用视觉模型的子代理做 OCR，返回 TOPIC/TEXT/HAS_FIGURE/FIGURE_DESC。

【工作方式（重要）】
1. 每轮先用工具确认信息（当前题目/学生历史/草稿），不要靠记忆。
2. 涉及任何计算都先调用 calc，再把结果讲给学生。
3. 需要切题/判答/记录历史/出新题等动作时，**必须**调用对应工具。
4. 涉及任何计算（哪怕是 12 ÷ 3）都先调用 calc，避免心算出错。
5. 回复用简短中文，可使用 $...$ 写公式（KaTeX）。

【出题准则】
- 用学而思大白本风格的小学高年级经典题型（鸡兔同笼/行程/工程/分数百分数应用/年龄/平均数/和倍/植树/容斥/盈亏/数论/几何等）。
- 难度匹配学生水平（结合 ability_report）。
- 题面用中文，必要时用 \\$...\\$ 嵌公式。answer 给标准答案字符串；hints 给 2-3 条逐步引导。

【识题（OCR）流程】
- 学生上传一张"题目图片"后，**你（主代理）看不到图片**。第一步必须调用 recognize_problem_image，让视觉子代理识别。
- 子代理返回里若 HAS_FIGURE=true，说明原图含相关图形，propose_problem 时务必设 figure: \\{type:"image"\\}，系统会自动把原图保留为新题插图。
- 拿到识别结果后，自己解一遍这道题得到 answer，写 2-3 条 hints，再调用 propose_problem 提交。
- 如果子代理返回 UNCLEAR 或识别失败，在对话里向学生说明并请求重传，不要凭猜测出题。`;

const SYSTEM_PROMPT_STUDENT = `
【当前模式：学生版 —— 你直接面对小学生本人】
**核心约束（非常重要）：**
- **绝对不要主动分析题目、不要主动给思路/解法/提示/步骤。** 即使你刚刚识别了一道新题、即使学生答错了，也不要在对话里讲解这道题怎么做。
- 学生上传题目图片后：只调用 recognize_problem_image + propose_problem，回复里只说"我识别了一道新题，确认一下要不要做"，**不要**附带思路或讲解。
- 学生答错后：可以简短鼓励（"差一点点，再想想？"），但**不要**指出错在哪、不要给下一步提示，除非学生主动问。
- **只有当学生明确提出问题**（例如"这题怎么做""给我个提示""我第二步对吗""为什么用乘法"）时，才回答那个具体问题，且仍以引导为主、不轻易直接给答案。
- propose_problem 里的 hints 字段可以照常写（它会折叠在"查看提示"里，学生主动点开才算），但对话回复里不要复述这些提示。
- 语气鼓励、简短（1-2 句），可用 1 个 emoji。不要长篇大论。

【出题准则补充】
- 出题时不要在回复里解释题目考查什么、怎么做。题面本身已经足够。`;

const SYSTEM_PROMPT_PARENT = `
【当前模式：家长版 —— 你面对的是家长，他在辅导孩子】
- 你可以（也应该）主动分析题目、给出解题思路、讲解这道题考查的知识点和孩子容易卡住的地方。
- 识别题目后，除了 propose_problem，还应在对话里向家长说明：这道题的考点、推荐的辅导思路、可以问孩子的启发性问题、孩子常见的错误类型。
- 关注"如何启发孩子"而不是"怎么给答案"：给家长的是辅导策略，让家长去引导孩子，而不是替孩子解题。
- 学生（孩子）答错时，帮家长分析错因，并建议家长如何提问引导孩子自己发现错误。
- 可以适当长一些（2-4 段），用 $...$ 写公式，方便家长看懂。
- 语气专业、清晰，对家长不用刻意装可爱。`;

function buildSystemPrompt(mode) {
  const suffix = mode === 'parent' ? SYSTEM_PROMPT_PARENT : SYSTEM_PROMPT_STUDENT;
  return SYSTEM_PROMPT_BASE + suffix;
}


// ---------- 共享业务状态（per session）----------
function compareAnswer(u, c) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, '').replace(/，/g, ',');
  const U = norm(u), C = norm(c);
  if (U === C) return true;
  const un = parseFloat(U), cn = parseFloat(C);
  if (!isNaN(un) && !isNaN(cn) && Math.abs(un - cn) < 1e-6) return true;
  if (U.includes(C) || C.includes(U)) return true;
  return false;
}

function safeCalc(expr) {
  if (!/^[\d+\-*/().\s]+$/.test(expr)) throw new Error('only digits, + - * / ( ) allowed');
  // eslint-disable-next-line no-new-func
  const v = Function('"use strict";return (' + expr + ')')();
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('not a finite number');
  return v;
}

// ---------- API 配置读取（环境变量 + ~/.claude/settings.json）----------
function getVisionApiConfig() {
  let baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL;
  let apiKey = process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || process.env.OPENAI_API_KEY;

  if (!baseUrl || !apiKey) {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const env = s.env || {};
        baseUrl = baseUrl || env.ANTHROPIC_BASE_URL;
        apiKey = apiKey || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
      }
    } catch {}
  }
  if (!baseUrl) baseUrl = 'https://api.anthropic.com';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

// ---------- 视觉识别：直接 HTTP 调用（OpenAI / Anthropic 兼容接口）----------
// 不再使用 Claude Agent SDK 的子代理 query()，因为 SDK 子代理在第三方
// OpenAI 兼容 API（如 SiliconFlow）上多模态图片格式适配不可靠，会报 not a VLM。
// 改为直接 fetch 对应平台的 /chat/completions 或 /v1/messages 接口。
async function runVisionHttp(imageDataUrl, emit) {
  const m = String(imageDataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('invalid image data url');
  const mediaType = m[1], base64Data = m[2];

  const { baseUrl, apiKey } = getVisionApiConfig();
  if (!apiKey) throw new Error('未找到 API Key。请设置 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 环境变量，或通过 claude login 登录。');

  const isAnthropic = /anthropic\.com$/i.test(new URL(baseUrl).hostname);
  const model = VISION_MODEL;
  const visionPrompt = VISION_SUBAGENT_PROMPT + '\n\n请识别图片，按上述指定格式直接输出结果，绝对不要输出任何思考过程、不要用<thinking>标签。';

  if (emit) emit('ui_event', { type: 'vision_subagent_started', model });

  const t0 = Date.now();
  let resp, body;
  try {
    let url, payload, headers;
    if (isAnthropic) {
      url = `${baseUrl}/v1/messages`;
      headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
      payload = {
        model,
        max_tokens: 2048,
        system: VISION_SUBAGENT_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: '请识别这张小学数学题图片，按指定格式输出。' }
          ]
        }]
      };
    } else {
      url = `${baseUrl}/chat/completions`.replace(/\/+/g, '/').replace(':/', '://');
      if (!/\/v\d+\//.test(url) && !url.includes('/chat/completions')) {
        url = `${baseUrl}/v1/chat/completions`.replace(/\/+/g, '/').replace(':/', '://');
      }
      headers = {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`
      };
      payload = {
        model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'text', text: visionPrompt }
          ]
        }]
      };
    }
    console.log(`[vision] POST ${url} model=${model}`);
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    console.error('[vision] network error', e.message);
    throw new Error(`视觉 API 网络错误: ${e.message}\n请求地址: ${baseUrl}, 模型: ${model}`);
  }

  body = await resp.text();
  if (!resp.ok) {
    let detail = body.slice(0, 1000);
    try {
      const j = JSON.parse(body);
      const msg = j.error?.message || j.message || JSON.stringify(j.error || j);
      if (/not a VLM|not.*vision|VLM|not support.*image/i.test(msg)) {
        detail = `模型 "${model}" 在该 API 上不支持图片识别。\n`
          + `你当前使用的 API 地址是: ${baseUrl}\n`
          + `请确认该平台上有可用的视觉模型，并通过环境变量指定，例如：\n`
          + `  VISION_MODEL=Pro/Qwen/Qwen2.5-VL-7B-Instruct node server.js\n`
          + `SiliconFlow 可用的视觉模型通常以 VL/VLM 结尾，可在控制台模型列表查看。\n`
          + `原始错误：${msg}`;
      } else {
        detail = msg;
      }
    } catch {}
    console.error('[vision] HTTP error', resp.status, detail.slice(0, 300));
    throw new Error(`视觉 API HTTP ${resp.status}: ${detail}`);
  }

  let text = '';
  try {
    const j = JSON.parse(body);
    if (isAnthropic) {
      for (const block of (j.content || [])) {
        if (block.type === 'text' && block.text) text += block.text;
      }
    } else {
      const content = j.choices?.[0]?.message?.content;
      if (Array.isArray(content)) {
        text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      } else {
        text = content || '';
      }
    }
  } catch {
    text = body;
  }

  text = (text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if (!text) {
    throw new Error(`视觉模型没有返回文本内容（model=${model}, baseUrl=${baseUrl}）`);
  }

  console.log(`[vision] recognized ${text.length} chars in ${Date.now() - t0}ms via ${model}`);
  if (emit) emit('ui_event', { type: 'vision_subagent_done', length: text.length, elapsed_ms: Date.now() - t0 });
  return text;
}

function runVisionSubagent(imageDataUrl, emit) {
  return runVisionHttp(imageDataUrl, emit);
}

// ---------- SDK MCP 工具集（in-process）----------
// 工具返回 { content: [{type:'text', text: ...}] }（CallToolResult 形状）
// 我们把要给前端 UI 的副作用通过 session.emit(ui_event, ...) 推送
function buildTutorMcp(session) {
  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const err = (msg) => ({ content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true });

  function findProblem(id) {
    return getProblem(id) || (session.proposedProblems || []).find(x => x.id === id);
  }

  return createSdkMcpServer({
    name: 'tutor',
    version: '0.2.0',
    instructions: '小学数学辅导工具集：读取/切换题目、判答、记录、计算等。题目持久化在 SQLite 数据库中。',
    tools: [
      tool('get_current_problem', '读取学生当前正在做的题目（含正确答案）', {}, async () => {
        const p = findProblem(session.currentProblemId);
        if (!p) return err('current problem missing');
        return ok({
          id: p.id, topic: p.topic, text: p.text, figure: p.figure,
          answer: p.answer, hints: p.hints
        });
      }),

      tool('list_problems', '列出题库索引（不含答案）', {}, async () => {
        const all = getAllProblems();
        const proposed = session.proposedProblems || [];
        const allWithPending = [...all, ...proposed.filter(pp => !all.find(a => a.id === pp.id))];
        return ok({
          items: allWithPending.map(p => ({
            id: p.id, topic: p.topic,
            preview: p.text.length > 50 ? p.text.slice(0, 50) + '…' : p.text,
            is_current: p.id === session.currentProblemId,
            source: p.source || (p.proposed ? 'pending' : 'builtin')
          }))
        });
      }),

      tool('set_current_problem', '把页面上正在显示的题目切到指定 id', {
        problem_id: z.string().describe('题目 id, 例如 p2')
      }, async (args) => {
        let p = getProblem(args.problem_id);
        if (!p) {
          p = (session.proposedProblems || []).find(x => x.id === args.problem_id);
        }
        if (!p) return err('problem not found: ' + args.problem_id);
        session.currentProblemId = p.id;
        session.emit('ui_event', { type: 'set_problem', problem_id: p.id });
        return ok({ ok: true, switched_to: p.id, topic: p.topic });
      }),

      tool('delete_problem',
        '从题库删除一道题（学生说"删掉这题/不要这题"时调用）。不传 problem_id 则删当前题。删除后页面会自动切到下一题。',
        {
          problem_id: z.string().optional().describe('要删除的题目 id；不传则删当前题')
        },
        async (args) => {
          const id = args.problem_id || session.currentProblemId;
          if (!id) return err('no problem to delete');
          const p = getProblem(id);
          const removed = deleteProblem(id);
          // 也从 pending proposed 列表移除
          if (session.proposedProblems) {
            session.proposedProblems = session.proposedProblems.filter(x => x.id !== id);
          }
          // 选下一道当前题
          const remaining = getAllProblems();
          let nextId = null;
          if (remaining.length) nextId = remaining[0].id;
          session.currentProblemId = nextId;
          session.emit('ui_event', { type: 'problems_changed', deleted_id: id, current_problem_id: nextId });
          return ok({ ok: removed, deleted_id: id, had: !!p, remaining: remaining.length, current_problem_id: nextId });
        }),

      tool('propose_problem',
        '向学生提议一道新题，会在网页弹窗让学生确认是否替换当前题。学生确认后这道题会保存到 SQLite 题库并被切换显示；学生取消则什么也不发生。',
        {
          topic: z.string().describe('主题分类，例如 鸡兔同笼 / 行程 / 工程'),
          text: z.string().describe('题面正文，使用中文，公式用 $...$'),
          answer: z.string().describe('标准答案，字符串形式（数字、分数 "11/12"、或带单位描述）'),
          hints: z.array(z.string()).min(1).describe('2-3 条递进式提示'),
          figure: z.object({
            type: z.enum(['rect', 'right-triangle', 'image']),
            width: z.number().optional(),
            height: z.number().optional(),
            unit: z.string().optional(),
            a: z.number().optional(),
            b: z.number().optional()
          }).optional().describe('可选的几何图。rect 用 width/height/unit；right-triangle 用 a/b；**image** = 直接保留学生刚上传的题目图片中的原图作为插图（当原图含题目相关图形时使用）')
        },
        async (args) => {
          const id = 'ai_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
          const problem = {
            id, topic: args.topic, text: args.text, answer: args.answer,
            hints: args.hints, figure: args.figure, proposed: true, source: 'ai'
          };
          let hasFig = false;
          if (args.figure && args.figure.type === 'image' && session.lastImage) {
            problem.figureImage = session.lastImage;
            hasFig = true;
          }
          session.proposedProblems = session.proposedProblems || [];
          session.proposedProblems.push(problem);
          session.emit('ui_event', { type: 'problem_proposed', problem });
          return ok({
            ok: true,
            problem_id: id,
            figure_attached: hasFig,
            note: hasFig
              ? '已向学生弹窗，并把上传的原图作为插图一并展示。学生若确认会保存到数据库并替换到做题区。'
              : '已向学生弹窗。学生若确认会保存到数据库并替换到做题区。学生若取消，提议作废。'
          });
        }
      ),

      tool('recognize_problem_image',
        '识别学生刚上传的题目图片。**主代理看不到图片内容**，必须调用此工具：会启动一个使用视觉模型（' + VISION_MODEL + '）的子代理做 OCR，返回 TOPIC/TEXT/HAS_FIGURE/FIGURE_DESC 字段。拿到结果后据此 propose_problem；若 HAS_FIGURE=true，propose_problem 时设 figure.type=image 保留原图。',
        {},
        async () => {
          if (!session.lastImage) return err('没有可识别的图片：请让学生先上传一张题目图片');
          const t0 = Date.now();
          try {
            const text = await runVisionSubagent(session.lastImage, session.emit.bind(session));
            return ok({ recognized: text, elapsed_ms: Date.now() - t0, model: VISION_MODEL });
          } catch (e) {
            return err('视觉子代理失败: ' + (e.message || String(e))
              + '（检查 VISION_MODEL=' + VISION_MODEL + ' 是否是支持视觉的模型）');
          }
        }
      ),

      tool('check_answer', '判断学生答案是否正确（容错比较）', {
        problem_id: z.string(),
        user_answer: z.string()
      }, async (args) => {
        const p = findProblem(args.problem_id);
        if (!p) return err('problem not found');
        return ok({ correct: compareAnswer(args.user_answer, p.answer), expected: p.answer });
      }),

      tool('record_history', '把一次提交结果记入学生历史', {
        problem_id: z.string(),
        user_answer: z.string(),
        correct: z.boolean()
      }, async (args) => {
        const p = findProblem(args.problem_id);
        session.history.push({
          problemId: args.problem_id,
          topic: p ? p.topic : '?',
          finalAnswer: args.user_answer,
          correctAnswer: p ? p.answer : '?',
          correct: !!args.correct,
          time: new Date().toISOString()
        });
        session.history = session.history.slice(-50);
        session.emit('ui_event', { type: 'history_updated', count: session.history.length });
        return ok({ ok: true, total: session.history.length });
      }),

      tool('ability_report', '基于历史输出水平摘要', {}, async () => {
        const total = session.history.length;
        if (!total) return ok({ total: 0, summary: '还没有历史记录' });
        const correct = session.history.filter(h => h.correct).length;
        const byTopic = {};
        for (const h of session.history) {
          const t = h.topic || '其他';
          byTopic[t] = byTopic[t] || { c: 0, t: 0 };
          byTopic[t].t++;
          if (h.correct) byTopic[t].c++;
        }
        return ok({
          total,
          rate: Math.round(correct / total * 100),
          by_topic: Object.fromEntries(Object.entries(byTopic).map(([k, v]) =>
            [k, `${v.c}/${v.t} (${Math.round(v.c / v.t * 100)}%)`]))
        });
      }),

      tool('read_scratch_state', '查看学生草稿区笔画数', {}, async () => {
        return ok({ strokes: session.scratchStrokes });
      }),

      tool('calc', '安全计算数学表达式 (+ - * / 与括号), 例如 "12 - (12/3) - 2"', {
        expression: z.string()
      }, async (args) => {
        try {
          return ok({ expression: args.expression, result: safeCalc(args.expression) });
        } catch (e) {
          return err('invalid expression: ' + e.message);
        }
      })
    ]
  });
}

// ---------- 流式输入队列：把 fetch 的 user message 推给 SDK ----------
function createInputQueue() {
  const buf = [];
  let resolver = null;
  let closed = false;
  return {
    push(msg) {
      if (closed) return;
      if (resolver) { const r = resolver; resolver = null; r({ value: msg, done: false }); }
      else buf.push(msg);
    },
    close() {
      closed = true;
      if (resolver) { const r = resolver; resolver = null; r({ value: undefined, done: true }); }
    },
    iterable() {
      const self = this;
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise(r => { resolver = r; });
        },
        return() { closed = true; return Promise.resolve({ value: undefined, done: true }); }
      };
    }
  };
}

// ---------- 创建一个 SDK 驱动的 session ----------
function createSession(opts = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const subscribers = new Set(); // 当前 turn 的 SSE 订阅者（每个 turn 通常 1 个）
  const mode = opts.mode === 'parent' ? 'parent' : 'student';

  getDb();
  const allProblems = getAllProblems();
  const firstProblemId = allProblems.length > 0 ? allProblems[0].id : null;

  const session = {
    id,
    mode,
    createdAt: Date.now(),
    currentProblemId: firstProblemId,
    history: [],
    scratchStrokes: 0,
    queue: createInputQueue(),
    query: null,
    runPromise: null,
    closed: false,
    emit(event, data) {
      for (const sub of subscribers) sub(event, data);
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  };

  // 注册 MCP 工具集，并禁用所有内置工具（学生学习场景不需要 Bash/Read 等）
  const tutorMcp = buildTutorMcp(session);

  session.query = query({
    prompt: session.queue.iterable(),
    options: {
      systemPrompt: buildSystemPrompt(mode),
      mcpServers: { tutor: tutorMcp },
      tools: [],                  // 禁用内置工具
      allowedTools: [             // 显式放行我们的 MCP 工具
        'mcp__tutor__get_current_problem',
        'mcp__tutor__list_problems',
        'mcp__tutor__set_current_problem',
        'mcp__tutor__delete_problem',
        'mcp__tutor__propose_problem',
        'mcp__tutor__recognize_problem_image',
        'mcp__tutor__check_answer',
        'mcp__tutor__record_history',
        'mcp__tutor__ability_report',
        'mcp__tutor__read_scratch_state',
        'mcp__tutor__calc'
      ],
      permissionMode: 'bypassPermissions',
      persistSession: false,
      includePartialMessages: true,
      ...(process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'selflearning/0.1.0' }
    }
  });

  // 后台循环：把 SDK 消息推给当前订阅者
  session.runPromise = (async () => {
    try {
      for await (const msg of session.query) {
        if (session.closed) break;
        session.emit('sdk_message', msg);
      }
    } catch (e) {
      const errMsg = e.message || String(e);
      let detail = errMsg;
      if (e.status) detail = `[HTTP ${e.status}] ${errMsg}`;
      if (e.type === 'authentication_error' || /api key|auth/i.test(errMsg)) {
        detail = `鉴权失败：请检查 ANTHROPIC_API_KEY 是否正确设置。\n${errMsg}`;
      } else if (/rate limit|overloaded/i.test(errMsg)) {
        detail = `API 限流/过载，请稍后重试：\n${errMsg}`;
      } else if (/network|fetch|ECONNRESET|ETIMEDOUT/i.test(errMsg)) {
        detail = `网络错误，请检查网络连接：\n${errMsg}`;
      }
      console.error('[sdk error]', e);
      session.emit('error', { message: detail });
      session.emit('done', {});
    }
  })();

  sessions.set(id, session);
  return session;
}

async function destroySession(s) {
  if (!s || s.closed) return;
  s.closed = true;
  try { s.queue.close(); } catch { }
  try { s.query && s.query.close && s.query.close(); } catch { }
  sessions.delete(s.id);
}

// ---------- HTTP server ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(STATIC_ROOT, p);
  if (!filePath.startsWith(STATIC_ROOT)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'not found: ' + p });
    const ext = path.extname(p).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  });
}

function readJsonBody(req, maxBytes = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  try {
    if (req.method === 'GET' && pathname === '/api/problems') {
      const problems = getProblemsForClient();
      return send(res, 200, problems);
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/problem/')) {
      const id = decodeURIComponent(pathname.split('/').slice(3).join('/'));
      if (!id) return send(res, 400, { error: 'missing id' });
      const p = getProblem(id);
      const removed = deleteProblem(id);
      const remaining = getAllProblems();
      let nextId = null;
      if (remaining.length) nextId = remaining[0].id;
      // 若有活跃 session 正在用这道题，重置其 currentProblemId
      for (const s of sessions.values()) {
        if (s.currentProblemId === id) s.currentProblemId = nextId;
      }
      return send(res, 200, { ok: removed, id, had: !!p, remaining: remaining.length, current_problem_id: nextId });
    }

    if (req.method === 'POST' && pathname === '/api/session') {
      const body = await readJsonBody(req).catch(() => ({}));
      const s = createSession(body);
      return send(res, 200, { id: s.id, mode: s.mode, currentProblemId: s.currentProblemId });
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/session/')) {
      const id = pathname.split('/')[3];
      const s = sessions.get(id);
      if (s) await destroySession(s);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/scratch')) {
      const id = pathname.split('/')[3];
      const s = sessions.get(id);
      if (!s) return send(res, 404, { error: 'session not found' });
      const body = await readJsonBody(req);
      s.scratchStrokes = body.strokes || 0;
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/proposal')) {
      const id = pathname.split('/')[3];
      const s = sessions.get(id);
      if (!s) return send(res, 404, { error: 'session not found' });
      const body = await readJsonBody(req);
      // 学生对 propose_problem 的应答：accept 后保存到数据库并切到该题；cancel 则丢弃
      if (body.action === 'accept' && body.problem_id) {
        const p = (s.proposedProblems || []).find(x => x.id === body.problem_id);
        if (p) {
          if (!getProblem(p.id)) {
            insertProblem({
              id: p.id,
              topic: p.topic,
              text: p.text,
              answer: p.answer,
              hints: p.hints,
              figure: p.figure,
              imageDataUrl: p.figureImage || null,
              source: 'ai'
            });
            if (p.figure && p.figure.type === 'image' && p.figureImage) {
              updateProblemFigure(p.id, p.figure, p.figureImage);
            }
            console.log(`[db] saved AI problem: ${p.id} (${p.topic})`);
          }
          s.currentProblemId = p.id;
        }
      }
      // 把决定作为一条"系统用户消息"（shouldQuery=false）写进 transcript，让下一轮 agent 知道
      try {
        s.queue.push({
          type: 'user',
          message: {
            role: 'user',
            content: `[系统通知] 学生${body.action === 'accept' ? '已确认替换为新题' : '取消了'}提议: ${body.problem_id}`
          },
          parent_tool_use_id: null,
          session_id: s.id,
          shouldQuery: false
        });
      } catch { }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/session/') && pathname.endsWith('/turn')) {
      const id = pathname.split('/')[3];
      const s = sessions.get(id);
      if (!s) return send(res, 404, { error: 'session not found' });
      const body = await readJsonBody(req);
      const userMsg = (body.message || '').trim();
      const imgBody = body.image;
      const audioBody = body.audio;
      if (!userMsg && !imgBody && !audioBody) return send(res, 400, { error: 'empty message' });
      if (typeof body.currentProblemId === 'string') s.currentProblemId = body.currentProblemId;
      if (typeof body.scratchStrokes === 'number') s.scratchStrokes = body.scratchStrokes;

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      const send_ = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send_('user', { message: userMsg, hasImage: !!imgBody, hasAudio: !!audioBody });

      const unsubscribe = s.subscribe((event, data) => {
        send_(event, data);
        if (event === 'sdk_message' && data.type === 'result') {
          send_('done', {});
          setImmediate(() => { try { res.end(); } catch { } });
        } else if (event === 'error') {
          send_('done', {});
          setImmediate(() => { try { res.end(); } catch { } });
        }
      });
      req.on('close', () => { unsubscribe(); });

      // 组装 user message: 纯文本 / 文本+音频。
      // 图片不直接放入消息 content（因为主代理可能是文本模型，不支持视觉，会报 400 "not a VLM"）。
      // 图片只存到 s.lastImage，主代理通过调用 recognize_problem_image 工具来获取识别结果。
      // 为了让主代理知道有图片，在文本末尾追加提示。
      try {
        let effectiveText = userMsg || '';
        if (imgBody && imgBody.data) {
          s.lastImage = `data:${imgBody.mediaType || 'image/jpeg'};base64,${imgBody.data}`;
          if (effectiveText && !/(图片|image|照片|上传|识别)/i.test(effectiveText)) {
            effectiveText += '\n\n（学生刚刚上传了一张图片。如果你需要查看图片内容，请调用 recognize_problem_image 工具。）';
          } else if (!effectiveText) {
            effectiveText = '（学生上传了一张图片，请调用 recognize_problem_image 工具识别图片内容。）';
          }
        }
        const content = [];
        if (audioBody && audioBody.data) {
          content.push({ type: 'audio', source: { type: 'base64', media_type: audioBody.mediaType || 'audio/webm', data: audioBody.data } });
        }
        if (effectiveText) {
          content.push({ type: 'text', text: effectiveText });
        }
        if (content.length === 0) {
          send_('error', { message: '消息内容为空' });
          send_('done', {});
          setImmediate(() => { try { res.end(); } catch { } });
          return;
        }
        const finalContent = content.length === 1 && content[0].type === 'text' ? content[0].text : content;

        s.queue.push({
          type: 'user',
          message: { role: 'user', content: finalContent },
          parent_tool_use_id: null,
          session_id: s.id
        });
      } catch (e) {
        send_('error', { message: '消息入队失败: ' + (e.message || String(e)) });
        send_('done', {});
        setImmediate(() => { try { res.end(); } catch { } });
      }
      return;
    }

    return serveStatic(req, res, pathname);
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
