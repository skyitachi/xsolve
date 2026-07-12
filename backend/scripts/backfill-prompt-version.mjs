// 数据回填脚本：把历史数据（prompt_version_id 为 NULL 的 chat_turns / eval_scores）
// 用「当前各 role 正在使用的活跃 prompt 版本」填充。
//
// 用法：
//   node backend/scripts/backfill-prompt-version.mjs            # 仅预览，不修改
//   node backend/scripts/backfill-prompt-version.mjs --apply    # 实际写入
//
// 说明：
//   - 复用 app 的 db.js，加载时其内置迁移会把 eval_scores.prompt_version_id 列补上
//   - 按 role 取 prompt_versions 中 is_active=1 的版本 id 作为「当前 prompt」
//   - chat_turns：同 role 的 NULL 行填充为该 role 的活跃版本
//   - eval_scores：从关联的 chat_turns.prompt_version_id 回填

import { getDb } from '../db.js';

const APPLY = process.argv.includes('--apply');

const db = getDb();

// 兜底：确保 eval_scores.prompt_version_id 列存在（db.js 加载时通常已迁移）
try {
  db.prepare('SELECT prompt_version_id FROM eval_scores LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE eval_scores ADD COLUMN prompt_version_id TEXT');
  console.log('[migrate] added eval_scores.prompt_version_id');
}

// 1. 当前各 role 的活跃 prompt 版本
const activeRows = db.prepare("SELECT id, role, version FROM prompt_versions WHERE is_active = 1").all();
const activeByRole = {};
for (const r of activeRows) activeByRole[r.role] = r;
console.log('活跃 prompt 版本：');
for (const [role, r] of Object.entries(activeByRole)) {
  console.log(`  ${role}: v${r.version} (${r.id})`);
}

if (Object.keys(activeByRole).length === 0) {
  console.error('未找到任何 active 的 prompt 版本，无法回填。请先在 prompt 管理界面设置一个活跃版本。');
  process.exit(1);
}

// 2. 预览 / 计算待回填数量
const turnStats = db.prepare(`
  SELECT role, COUNT(*) AS c
  FROM chat_turns
  WHERE prompt_version_id IS NULL
  GROUP BY role
`).all();

const turnsToFill = {};
let totalTurns = 0;
for (const r of turnStats) {
  if (activeByRole[r.role]) {
    turnsToFill[r.role] = r.c;
    totalTurns += r.c;
  }
}
const turnsNoActive = turnStats.filter(r => !activeByRole[r.role]);

const scoresToFill = db.prepare(`
  SELECT COUNT(*) AS c
  FROM eval_scores es
  WHERE es.prompt_version_id IS NULL
    AND es.turn_id IN (SELECT id FROM chat_turns WHERE prompt_version_id IS NOT NULL)
`).get().c;

console.log('\n待回填 chat_turns（按 role）：');
for (const [role, c] of Object.entries(turnsToFill)) console.log(`  ${role}: ${c} 行 -> ${activeByRole[role].id}`);
if (turnsNoActive.length) console.log('  跳过（无活跃 prompt 版本）:', turnsNoActive.map(r => `${r.role}:${r.c}`).join(', '));
console.log(`总计 chat_turns: ${totalTurns} 行`);
console.log(`待回填 eval_scores（从关联 turn 回填）: ${scoresToFill} 行`);

if (!APPLY) {
  console.log('\n[DRY-RUN] 未做任何修改。加 --apply 参数以实际写入。');
  process.exit(0);
}

// 3. 实际回填（事务）
const tx = db.transaction(() => {
  let updatedTurns = 0;
  for (const [role, id] of Object.entries(activeByRole)) {
    const info = db.prepare("UPDATE chat_turns SET prompt_version_id = ? WHERE prompt_version_id IS NULL AND role = ?").run(id.id, role);
    updatedTurns += info.changes;
  }
  const info2 = db.prepare(`
    UPDATE eval_scores
    SET prompt_version_id = (SELECT t.prompt_version_id FROM chat_turns t WHERE t.id = eval_scores.turn_id)
    WHERE prompt_version_id IS NULL
      AND turn_id IN (SELECT id FROM chat_turns WHERE prompt_version_id IS NOT NULL)
  `).run();
  return { updatedTurns, updatedScores: info2.changes };
});

const res = tx();

// 4. 回填后校验
const remTurns = db.prepare("SELECT COUNT(*) c FROM chat_turns WHERE prompt_version_id IS NULL").get().c;
const remScores = db.prepare("SELECT COUNT(*) c FROM eval_scores WHERE prompt_version_id IS NULL").get().c;

console.log('\n[APPLIED]');
console.log(`  chat_turns 已填充: ${res.updatedTurns} 行，剩余 NULL: ${remTurns}`);
console.log(`  eval_scores 已填充: ${res.updatedScores} 行，剩余 NULL: ${remScores}`);
