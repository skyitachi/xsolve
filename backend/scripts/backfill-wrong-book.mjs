// 把历史错题回填进错题本（一次性迁移脚本）
//
// 背景：错题本上线前，学生答错的流水只存在于 student_attempts 里，
// wrong_items 是空的。不跑这个脚本，孩子会看到「错题本是空的」，
// 而实际上他之前错过的题都还在。
//
// 用法（默认**演练**，不写库）：
//   node backend/scripts/backfill-wrong-book.mjs            # 只看会写什么
//   node backend/scripts/backfill-wrong-book.mjs --apply    # 真的写
// 指定库：
//   DB_PATH=/path/to/xsolve.db node backend/scripts/backfill-wrong-book.mjs --apply
//
// 幂等：同一 (student_id, problem_id) 只会有一条 wrong_items，
// 重复执行只会把 wrong_count 累加 —— 所以**只跑一次**，别放进 cron。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ⚠️ 必须在 import db.js 之前设好，否则会连到仓库默认库
process.env.DB_PATH = process.env.DB_PATH || path.join(ROOT, 'xsolve.db');

const apply = process.argv.includes('--apply');

const db = await import('../db.js');
const conn = db.getDb();

console.log(`库：${process.env.DB_PATH}`);
console.log(`模式：${apply ? '★ APPLY（会写库）' : 'DRY-RUN（只演练，加 --apply 才写）'}\n`);

// 只统计「题目还在」的错题 —— 题目已被删除的流水无法回填（错题本要能显示题面）
const rows = conn.prepare(`
  SELECT a.student_id,
         a.problem_id,
         COUNT(*)          AS wrong_times,
         MIN(a.created_at) AS first_at,
         MAX(a.created_at) AS last_at
  FROM student_attempts a
  JOIN problems p ON p.id = a.problem_id
  WHERE a.correct = 0 AND a.problem_id IS NOT NULL
  GROUP BY a.student_id, a.problem_id
  ORDER BY a.student_id, wrong_times DESC
`).all();

const orphan = conn.prepare(`
  SELECT COUNT(*) AS n
  FROM student_attempts a
  LEFT JOIN problems p ON p.id = a.problem_id
  WHERE a.correct = 0 AND a.problem_id IS NOT NULL AND p.id IS NULL
`).get().n;

if (!rows.length) {
  console.log('没有需要回填的错题（student_attempts 里没有 correct=0 且题目仍在的行）。');
  if (orphan) console.log(`另有 ${orphan} 行错题流水对应的题目已被删除，跳过。`);
  process.exit(0);
}

const byStudent = new Map();
for (const r of rows) {
  if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []);
  byStudent.get(r.student_id).push(r);
}

let created = 0;
let moved = 0;

for (const [studentId, list] of byStudent) {
  console.log(`学生 ${studentId}：${list.length} 道错题`);
  for (const r of list) {
    const existed = !!db.findWrongItemByProblem(studentId, r.problem_id);
    console.log(`  ${existed ? '·  已有' : '+  新增'}  ${r.problem_id}   错过 ${r.wrong_times} 次`);
    if (!apply) continue;
    try {
      // wrongCount = 历史上真实的出错次数（不是 1），
      // 否则「错 3 次」的题回填后只显示错 1 次。
      db.addWrongItem(studentId, {
        problemId: r.problem_id,
        source: 'auto',
        wrongCount: r.wrong_times,
      });
      existed ? moved++ : created++;
    } catch (e) {
      console.error(`  ✖ 回填失败 ${r.problem_id}: ${e.message}`);
    }
  }
  console.log('');
}

if (apply) {
  console.log(`完成：新增 ${created} 条，更新 ${moved} 条。`);
  const stats = conn.prepare(`
    SELECT student_id, COUNT(*) AS total,
           SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
    FROM wrong_items GROUP BY student_id
  `).all();
  console.log('回填后各学生错题本：');
  for (const s of stats) console.log(`  ${s.student_id}: 共 ${s.total}，待复习 ${s.pending}`);
} else {
  console.log('以上为演练结果，未写入。确认无误后加 --apply 执行。');
}
if (orphan) console.log(`\n注意：另有 ${orphan} 行错题流水对应的题目已被删除，无法回填（错题本需要题面）。`);
process.exit(0);
