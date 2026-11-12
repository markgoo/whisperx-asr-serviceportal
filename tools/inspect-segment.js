'use strict';
/** 查看某个任务在指定时间附近的段落，以及有没有词级数据。 */
const Database = require('better-sqlite3');
const db = new Database('C:/AI/whisperx-asr-serviceportal/data/portal.db');

const taskId = Number(process.argv[2] || 34);
const around = Number(process.argv[3] || 52 * 60 + 34);

const row = db.prepare('SELECT id, title, duration, segment_count, speaker_count, diarize, model, result_json FROM tasks WHERE id = ?').get(taskId);
if (!row) {
  console.log(`任务 #${taskId} 不存在`);
  process.exit(1);
}
console.log(`任务 #${row.id}  ${row.title}`);
console.log(`  时长 ${row.duration}s  分段 ${row.segment_count}  说话人 ${row.speaker_count}  模型 ${row.model || '(默认)'}`);

const segs = JSON.parse(row.result_json || '[]');
const idx = segs.findIndex((s) => s.start <= around && s.end >= around);
console.log(`\n=== ${around}s 所在的段落（索引 ${idx}）===`);
if (idx >= 0) {
  const s = segs[idx];
  console.log(`  [${s.start.toFixed(1)} - ${s.end.toFixed(1)}]  时长 ${(s.end - s.start).toFixed(1)}s  字数 ${s.text.length}`);
  console.log(`  ${s.text}`);
}

console.log('\n=== 前后各 2 段 ===');
for (let i = Math.max(0, idx - 2); i <= Math.min(segs.length - 1, idx + 2); i += 1) {
  const s = segs[i];
  const mark = i === idx ? '>>' : '  ';
  console.log(`${mark} [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${(s.end - s.start).toFixed(1)}s ${s.text.slice(0, 60)}`);
}

// 统计全任务的分段时长分布
const durs = segs.map((s) => s.end - s.start).sort((a, b) => b - a);
console.log('\n=== 分段时长分布 ===');
console.log(`  最长 ${durs[0].toFixed(1)}s  中位 ${durs[Math.floor(durs.length / 2)].toFixed(1)}s`);
console.log(`  >22s 的段落: ${durs.filter((d) => d > 22).length} 个`);
console.log(`  >30s 的段落: ${durs.filter((d) => d > 30).length} 个`);

// 检查长段落是否缺少标点
const long = segs.filter((s) => s.end - s.start > 22);
console.log(`\n=== 最长 3 段的内容 ===`);
for (const s of long.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 3)) {
  const commas = (s.text.match(/[，。！？]/g) || []).length;
  console.log(`  [${(s.end - s.start).toFixed(1)}s / ${s.text.length}字 / 标点${commas}个]`);
  console.log(`    ${s.text.slice(0, 100)}`);
}
db.close();
