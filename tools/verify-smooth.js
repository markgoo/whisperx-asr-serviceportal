'use strict';
/** 验证说话人平滑对碎片和抖动的影响。 */
const Database = require('better-sqlite3');

const { smoothSpeakers } = require('./dist/server/segmenter.js');

const db = new Database('/app/data/portal.db', { readonly: true });
const task = db.prepare("SELECT id, result_json FROM tasks WHERE status='completed' ORDER BY id DESC LIMIT 1").get();
const segs = JSON.parse(task.result_json);

function stats(list, label) {
  const short = list.filter((s) => s.end - s.start < 1.5).length;
  let flips = 0;
  for (let i = 2; i < list.length; i += 1) {
    if (list[i - 2].speaker === list[i].speaker && list[i - 1].speaker !== list[i].speaker) flips += 1;
  }
  const zero = list.filter((s) => s.end - s.start <= 0.2).length;
  console.log(`\n=== ${label} ===`);
  console.log(`  段数        ${list.length}`);
  console.log(`  <1.5秒碎片  ${short} (${((short / list.length) * 100).toFixed(0)}%)`);
  console.log(`  ≤0.2秒      ${zero}`);
  console.log(`  A→B→A 抖动  ${flips}`);
}

stats(segs, '平滑前');

// 模拟平滑（去掉标点后重新拼接，保持时间）
const smoothed = smoothSpeakers(segs.map((s) => ({ ...s })));
stats(smoothed, '平滑后');

console.log('\n=== 226-250 秒对比 ===');
console.log('--- 平滑前 ---');
for (const s of segs.filter((x) => x.start >= 226 && x.start <= 250)) {
  console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.speaker}  ${s.text}`);
}
console.log('--- 平滑后 ---');
for (const s of smoothed.filter((x) => x.start >= 226 && x.start <= 250)) {
  console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.speaker}  ${s.text}`);
}
db.close();
