// 升级脚本：把 config.js 里最新的「家长模式」系统提示词写入 DB 并激活。
//
// 背景：db.js 的 seedPromptVersions() 仅在 prompt_versions 表为空时执行。
// 现网 DB 已有数据，单纯改 config.js 不会生效；需主动 insertPromptVersion + activatePromptVersion。
//
// 运行：node backend/scripts/upgrade-parent-prompt.mjs
//
// 可重复运行：每次都会新建一个更高版本号并激活，旧版本保留以便回滚。
import { getDb, insertPromptVersion, activatePromptVersion } from '../db.js';
import { SYSTEM_PROMPT_BASE, SYSTEM_PROMPT_PARENT } from '../config.js';

const FULL_PARENT = SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_PARENT;

getDb(); // 触发 schema 初始化与 seed（如需）

const result = insertPromptVersion({
  role: 'parent',
  content: FULL_PARENT,
  description: '集成 jsxgraph-step-diagram：新增 generate_step_diagram 工具与分步作图工作流',
});
activatePromptVersion(result.id);

console.log('[upgrade] parent prompt 已更新并激活：');
console.log('  version:', result.version);
console.log('  id     :', result.id);
console.log('  内容长度:', FULL_PARENT.length, '字符');
console.log('  回滚方法：在 Prompt 管理页激活旧版本即可。');
