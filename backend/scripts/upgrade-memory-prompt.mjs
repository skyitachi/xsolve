// 升级脚本：把 config.js 里最新的系统提示词（含「学生记忆」说明段）写入 DB 并激活。
//
// 背景：db.js 的 seedPromptVersions() 仅在 prompt_versions 表为空时执行。
// 现网 DB 已有数据，单纯改 config.js 不会生效；需主动 insertPromptVersion + activatePromptVersion。
//
// 运行：node backend/scripts/upgrade-memory-prompt.mjs
//
// 可重复运行：每次都会为每个角色新建一个更高版本号并激活，旧版本保留以便回滚。
// 注意：需用 Node 26 运行（better-sqlite3 按 ABI 147 编译）。
import { getDb, insertPromptVersion, activatePromptVersion } from '../db.js';
import { SYSTEM_PROMPT_BASE, SYSTEM_PROMPT_STUDENT, SYSTEM_PROMPT_PARENT } from '../config.js';

getDb(); // 触发 schema 初始化与 seed（如需）

const roles = [
  ['student', SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_STUDENT],
  ['parent', SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_PARENT],
];

for (const [role, content] of roles) {
  const result = insertPromptVersion({
    role,
    content,
    description: '学生记忆系统 P1：新增 recall_memory / remember 工具与记忆使用说明（记忆摘要注入 + 语义画像固化 + 难度自适应 + 长会话压缩）',
  });
  activatePromptVersion(result.id);
  console.log(`[upgrade] ${role} prompt → v${result.version}（id=${result.id}）已激活，长度 ${content.length} 字符`);
}

console.log('完成。回滚方法：在 /prompts.html 激活旧版本即可。');
