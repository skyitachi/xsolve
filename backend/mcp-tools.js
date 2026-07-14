// MCP 工具集（tutor 工具服务器）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getAllProblems, getProblem, insertProblem, updateProblemFigure, updateChatSession } from './db.js';
import { runVisionHttp } from './vision.js';
import { CLAUDE_MODEL, SCRATCH_VISION_PROMPT } from './config.js';
import { compareAnswer, safeCalc, mcpOk, mcpErr } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, 'assets', 'step-diagram-template.html');
const DIAGRAMS_DIR = path.resolve(__dirname, '..', 'diagrams');

// 转义 HTML 文本（用于把模型给的标题安全塞进 <title>/<h2>）
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[c]));
}

// 视觉模型展示名（用于工具描述和响应）
const VISION_MODEL_DISPLAY = process.env.VISION_MODEL || CLAUDE_MODEL || 'claude-sonnet-4 (自动选择)';

/**
 * 构建 tutor MCP 工具服务器
 * @param {object} session - 会话对象
 */
export function buildTutorMcp(session) {
  function findProblem(id) {
    return getProblem(id) || (session.proposedProblems || []).find(x => x.id === id);
  }

  return createSdkMcpServer({
    name: 'tutor',
    version: '0.2.0',
    instructions: '小学数学辅导工具集：读取/切换题目、判答、记录、计算、视觉识别、草稿识别等。题目持久化在 SQLite 数据库中。',
    tools: [
      // ========== 题目相关 ==========
      tool('get_current_problem', '读取学生当前正在做的题目（含正确答案）', {}, async () => {
        const p = findProblem(session.currentProblemId);
        if (!p) return mcpErr('current problem missing');
        return mcpOk({
          id: p.id, topic: p.topic, text: p.text, figure: p.figure,
          answer: p.answer, hints: p.hints
        });
      }),

      tool('list_problems', '列出题库索引（不含答案）', {}, async () => {
        const all = getAllProblems();
        const proposed = session.proposedProblems || [];
        const allWithPending = [...all, ...proposed.filter(pp => !all.find(a => a.id === pp.id))];
        return mcpOk({
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
        if (!p) return mcpErr('problem not found: ' + args.problem_id);
        session.currentProblemId = p.id;
        updateChatSession(session.id, { current_problem_id: p.id });
        session.emit('ui_event', { type: 'set_problem', problem_id: p.id });
        return mcpOk({ ok: true, switched_to: p.id, topic: p.topic });
      }),

      tool('delete_problem',
        '向学生请求删除一道题。会在网页弹窗让学生确认是否删除；学生确认后才会真正从题库删除并切换到下一题，学生取消则什么也不发生。不传 problem_id 则默认请求删当前题。',
        {
          problem_id: z.string().optional().describe('要删除的题目 id；不传则请求删当前题')
        },
        async (args) => {
          const id = args.problem_id || session.currentProblemId;
          if (!id) return mcpErr('no problem to delete');
          const p = getProblem(id) || (session.proposedProblems || []).find(x => x.id === id);
          if (!p) return mcpErr('problem not found: ' + id);
          session.pendingDelete = { problem_id: id, topic: p.topic, text: p.text };
          session.emit('ui_event', {
            type: 'delete_proposed',
            problem: { id: p.id, topic: p.topic, text: p.text || '', preview: (p.text || '').slice(0, 60) }
          });
          return mcpOk({
            ok: true,
            problem_id: id,
            note: '已向学生弹窗确认删除。学生确认后会真正删除并切换到下一题；学生取消则不删除。请等待学生操作。'
          });
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
          }).optional().describe('可选的几何图。rect 用 width/height/unit；right-triangle 用 a/b；image = 直接保留学生刚上传的题目图片中的原图作为插图')
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
          return mcpOk({
            ok: true,
            problem_id: id,
            figure_attached: hasFig,
            note: hasFig
              ? '已向学生弹窗，并把上传的原图作为插图一并展示。学生若确认会保存到数据库并替换到做题区。'
              : '已向学生弹窗。学生若确认会保存到数据库并替换到做题区。学生若取消，提议作废。'
          });
        }
      ),

      // ========== 视觉识别 ==========
      tool('recognize_problem_image',
        '识别学生刚上传的题目图片。**主代理看不到图片内容**，必须调用此工具：会启动一个视觉模型子代理做 OCR，返回 TOPIC/TEXT/HAS_FIGURE/FIGURE_DESC 字段。拿到结果后据此 propose_problem；若 HAS_FIGURE=true，propose_problem 时设 figure.type=image 保留原图。',
        {},
        async () => {
          if (!session.lastImage) return mcpErr('没有可识别的图片：请让学生先上传一张题目图片');
          const t0 = Date.now();
          try {
            const text = await runVisionHttp(session.lastImage, session.emit.bind(session));
            return mcpOk({ recognized: text, elapsed_ms: Date.now() - t0, model: VISION_MODEL_DISPLAY });
          } catch (e) {
            return mcpErr('视觉子代理失败: ' + (e.message || String(e)));
          }
        }
      ),

      // ========== 答题与历史 ==========
      tool('check_answer', '判断学生答案是否正确（容错比较）', {
        problem_id: z.string(),
        user_answer: z.string()
      }, async (args) => {
        const p = findProblem(args.problem_id);
        if (!p) return mcpErr('problem not found');
        return mcpOk({ correct: compareAnswer(args.user_answer, p.answer), expected: p.answer });
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
        return mcpOk({ ok: true, total: session.history.length });
      }),

      tool('ability_report', '基于历史输出水平摘要', {}, async () => {
        const total = session.history.length;
        if (!total) return mcpOk({ total: 0, summary: '还没有历史记录' });
        const correct = session.history.filter(h => h.correct).length;
        const byTopic = {};
        for (const h of session.history) {
          const t = h.topic || '其他';
          byTopic[t] = byTopic[t] || { c: 0, t: 0 };
          byTopic[t].t++;
          if (h.correct) byTopic[t].c++;
        }
        return mcpOk({
          total,
          rate: Math.round(correct / total * 100),
          by_topic: Object.fromEntries(Object.entries(byTopic).map(([k, v]) =>
            [k, `${v.c}/${v.t} (${Math.round(v.c / v.t * 100)}%)`]))
        });
      }),

      // ========== 草稿相关 ==========
      tool('read_scratch_state', '查看学生草稿区笔画数', {}, async () => {
        return mcpOk({ strokes: session.scratchStrokes });
      }),

      tool('recognize_scratch',
        '识别学生草稿板上的手写内容（笔迹）。用视觉模型识别草稿图片，返回数学公式(LaTeX)、中文文字、最终答案和置信度。当你需要检查学生草稿上的计算过程时调用。',
        {},
        async () => {
          if (!session.scratchImage) return mcpErr('草稿板是空的：请让学生先在草稿区写字，或点击"识别草稿"按钮');
          const t0 = Date.now();
          try {
            session.emit('ui_event', { type: 'scratch_recognition_started', model: VISION_MODEL_DISPLAY });
            const rawText = await runVisionHttp(session.scratchImage, session.emit.bind(session), SCRATCH_VISION_PROMPT);
            // 尝试解析JSON
            let parsed;
            try {
              const cleaned = rawText.replace(/```(?:json)?\s*/g, '').replace(/```\s*$/g, '').trim();
              parsed = JSON.parse(cleaned);
            } catch {
              parsed = {
                expressions: [],
                text: rawText,
                final_answer: null,
                confidence: 'low',
                summary: '识别结果（JSON解析失败，返回原始文本）',
                raw: rawText
              };
            }
            session.emit('ui_event', { type: 'scratch_recognition_done', elapsed_ms: Date.now() - t0 });
            return mcpOk({
              ...parsed,
              elapsed_ms: Date.now() - t0,
              model: VISION_MODEL_DISPLAY
            });
          } catch (e) {
            return mcpErr('草稿识别失败: ' + (e.message || String(e)));
          }
        }
      ),

      // ========== 计算 ==========
      tool('calc', '安全计算数学表达式 (+ - * / 与括号), 例如 "12 - (12/3) - 2"', {
        expression: z.string()
      }, async (args) => {
        try {
          return mcpOk({ expression: args.expression, result: safeCalc(args.expression) });
        } catch (e) {
          return mcpErr('invalid expression: ' + e.message);
        }
      }),

      // ========== JSXGraph 分步作图（家长模式）==========
      tool('generate_step_diagram',
        '生成一个 JSXGraph 分步作图网页：把一道题的解题过程拆成若干步，每点「下一步」揭示该步新增的图元（点/线段/圆/函数曲线等）并同步显示中文说明。家长要求"按步骤画出来/分步演示/可视化解题过程"时调用。返回可在聊天中打开的网页 URL。',
        {
          title: z.string().describe('网页标题（中文），例如「用 JSXGraph 按步骤画等边三角形」'),
          boundingbox: z.array(z.number()).length(4)
            .describe('JSXGraph 画板可视范围，顺序必须是 [xmin, ymax, xmax, ymin]（注意第2位是y轴最大值）'),
          steps: z.number().int().min(1).describe('总步数，需与 setup 里 steps 数组长度一致'),
          show_axis: z.boolean().optional()
            .describe('是否显示默认坐标轴。默认 false（不画）——几何作图/尺规作图一般不需要坐标轴；画函数图像/坐标系题目时传 true。'),
          setup: z.string().describe(
            'JSXGraph 预建元素的 JS 代码字符串：用辅助函数 pt/seg/circ/txt/poly/arc/func 预建所有元素（初始 visible:false），' +
            '并定义 const steps = [{ els:[...], text:"第 n 步：说明" }, ...]。' +
            '辅助函数签名：pt(x,y,name,opt?) seg(p1,p2,opt?) circ(c,e,opt?) txt(x,y,s,opt?) poly(pts,opt?) arc(c,p1,p2,opt?) func(f,opt?)。' +
            '关键约束：keepaspectratio 已由模板内置无需写；交点用代数算并 () => A.X() 绑定，不要用 intersection 索引。'
          )
        },
        async (args) => {
          // 轻量校验：setup 必须含 pt(/seg(/circ( 等辅助函数或 board.create，以及 steps 数组定义
          if (!/board\.create\s*\(|\bpt\s*\(|\bseg\s*\(|\bcirc\s*\(|\btxt\s*\(/.test(args.setup)) {
            return mcpErr('setup 里未检测到辅助函数(pt/seg/circ/txt等)或 board.create(...)，请按模板写预建元素。');
          }
          if (!/\bsteps\s*=\s*\[/.test(args.setup)) {
            return mcpErr('setup 里未检测到 steps 数组定义，请定义 const steps = [{ els, text }, ...]。');
          }
          let template;
          try {
            template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
          } catch (e) {
            return mcpErr('读取模板失败: ' + (e.message || String(e)));
          }
          // 占位符替换（split/join 替换全部出现位置）
          const replacements = {
            __TITLE__: escapeHtml(args.title),
            __BOUNDINGBOX__: JSON.stringify(args.boundingbox),
            __N__: String(args.steps),
            __AXIS__: args.show_axis ? 'true' : 'false',
            __SETUP__: args.setup
          };
          let html = template;
          for (const [k, v] of Object.entries(replacements)) {
            html = html.split(k).join(String(v));
          }
          // 写入 diagrams 目录
          try {
            fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });
            const id = crypto.randomBytes(6).toString('hex');
            const fileName = `diagram_${id}.html`;
            const filePath = path.join(DIAGRAMS_DIR, fileName);
            fs.writeFileSync(filePath, html, 'utf-8');
            const url = `/diagrams/${fileName}`;
            session.emit('ui_event', { type: 'diagram_generated', url, title: args.title });
            return mcpOk({ ok: true, url, title: args.title, steps: args.steps, path: filePath });
          } catch (e) {
            return mcpErr('写入作图文件失败: ' + (e.message || String(e)));
          }
        }
      )
    ]
  });
}
