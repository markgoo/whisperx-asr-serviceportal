'use strict';
/** 检查说话人切换附近的碎片段。 */
const Database = require('better-sqlite3');

const db = new Database('/app/data/portal.db', { readonly: true });
const task = db
  .prepare("SELECT id, title, segment_count FROM tasks WHERE status='completed' ORDER BY id DESC LIMIT 1")
  .get();
if (!task) {
  console.log('没有已完成的任务');
  process.exit(0);
}
console.log(`任务 #${task.id} ${task.title}  ${task.segment_count} 段\n`);

const segs = JSON.parse(
  db.prepare('SELECT result_json FROM tasks WHERE id = ?').get(task.id).result_json,
);

console.log('=== 226-250 秒（截图那段）===');
for (const s of segs.filter((x) => x.start >= 222 && x.start <= 250)) {
  const dur = (s.end - s.start).toFixed(1);
  const chars = s.text.length;
  const flag = s.end - s.start < 1.5 ? '  ← 碎片' : '';
  console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${dur}s ${chars}字 ${s.speaker || '-'}  ${s.text}${flag}`);
}

console.log('\n=== 全任务碎片统计 ===');
const short = segs.filter((s) => s.end - s.start < 1.5);
console.log(`  总段数 ${segs.length}，短于 1.5 秒的 ${short.length} 个（${((short.length / segs.length) * 100).toFixed(0)}%）`);

// 说话人抖动：A→B→A 的模式
let flips = 0;
for (let i = 2; i < segs.length; i += 1) {
  if (segs[i - 2].speaker === segs[i].speaker && segs[i - 1].speaker !== segs[i].speaker) {
    flips += 1;
  }
}
console.log(`  A→B→A 说话人抖动 ${flips} 处`);
