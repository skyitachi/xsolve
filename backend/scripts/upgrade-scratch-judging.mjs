// 升级脚本：把「草稿纳入评判」写进 DB 的三套活跃提示词。
//
// 背景：db.js 的 seedPromptVersions() 仅在 prompt_versions 表为空时执行。
// 现网 DB 已有数据，单纯改 config.js 不会生效；需主动 insertPromptVersion + activatePromptVersion。
//
// 三套提示词：
//  1. student —— 来自 config.js（SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_STUDENT），新增「学生草稿」小节
//  2. parent  —— 同样来自 config.js（BASE + PARENT）
//  3. judge   —— turn 级评分提示词。DB 里是唯一来源（config.js 里只有 fallback），
//                因此在现有活跃版本内容上做定向替换，保留其它可能的改动。
//
// 运行：node backend/scripts/upgrade-scratch-judging.mjs
// 可重复运行：每次为每个角色新建更高版本号并激活，旧版本保留以便回滚。
// 注意：需用 Node 26 运行（better-sqlite3 按 ABI 147 编译）。
import { getDb, insertPromptVersion, activatePromptVersion } from '../db.js';
import { SYSTEM_PROMPT_BASE, SYSTEM_PROMPT_STUDENT, SYSTEM_PROMPT_PARENT } from '../config.js';

const db = getDb(); // 触发 schema 初始化与 seed（如需）

const MARKER = '系统注入·学生草稿内容';

// ---------- 1 & 2：student / parent（整体来自 config.js）----------
const roles = [
  ['student', SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_STUDENT],
  ['parent', SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_PARENT],
];

for (const [role, content] of roles) {
  if (!content.includes(MARKER)) {
    console.error(`[upgrade] ✗ ${role}: config.js 内容里没有草稿小节，跳过（请检查 config.js）`);
    continue;
  }
  const active = db.prepare(
    'SELECT version, content FROM prompt_versions WHERE role = ? AND is_active = 1'
  ).get(role);
  if (active && active.content.includes(MARKER)) {
    console.log(`[upgrade] ${role}: 活跃 v${active.version} 已含草稿小节，跳过`);
    continue;
  }
  const result = insertPromptVersion({
    role,
    content,
    description: '草稿纳入评判：系统每轮自动识别草稿并注入上下文；反馈需参考演算过程，但答案对错仍以 check_answer 为准',
  });
  activatePromptVersion(result.id);
  console.log(`[upgrade] ${role} prompt → v${result.version}（id=${result.id}）已激活，长度 ${content.length} 字符`);
}

// ---------- 3：judge（在现有活跃内容上定向替换）----------
const OLD_STRATEGY = '2. tutoring_strategy（1-5）：辅导策略是否恰当（引导而非代答、难度适配、循序渐进）。5=策略优秀，1=策略很差。';
const NEW_STRATEGY = '2. tutoring_strategy（1-5）：辅导策略是否恰当（引导而非代答、难度适配、循序渐进、**结合学生在草稿上的演算过程给出针对性反馈**）。5=策略优秀，1=策略很差。trace 里有「学生草稿」时，AI 若引用其中的演算步骤（如指出某一步进位错了）应加分；草稿里有明显错误过程而 AI 完全没提及，应减分。';

{
  const active = db.prepare(
    'SELECT id, version, content FROM prompt_versions WHERE role = ? AND is_active = 1'
  ).get('judge');

  if (!active) {
    console.error('[upgrade] ✗ judge: DB 无活跃版本，跳过（启动服务会 seed）');
  } else if (active.content.includes('结合学生在草稿上的演算过程')) {
    console.log(`[upgrade] judge: 活跃 v${active.version} 已含草稿要求，跳过`);
  } else if (!active.content.includes(OLD_STRATEGY)) {
    console.error('[upgrade] ✗ judge: 现有内容与预期不符（tutoring_strategy 行已被改过），为避免覆盖已跳过');
    console.error('  请在 /prompts.html 手动加：' + NEW_STRATEGY);
  } else {
    const nextContent = active.content.replace(OLD_STRATEGY, NEW_STRATEGY);
    const result = insertPromptVersion({
      role: 'judge',
      content: nextContent,
      description: '草稿纳入评判：tutoring_strategy 增加「是否结合学生草稿的演算过程做针对性反馈」',
    });
    activatePromptVersion(result.id);
    console.log(`[upgrade] judge prompt → v${result.version}（id=${result.id}）已激活，长度 ${nextContent.length} 字符`);
  }
}

console.log('\n完成。回滚方法：在 /prompts.html 激活旧版本即可。');
