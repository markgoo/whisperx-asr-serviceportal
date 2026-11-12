'use strict';
/** 新旧分句逻辑的整体指标对比。 */
const fs = require('node:fs');
const path = require('node:path');

const raw = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'ab-run1.json'), 'utf8'));
const segments = raw.segments || [];
const words = raw.word_segments || [];

const { splitByPause, DEFAULT_SPLIT, punctuate } = require('../dist/server/segmenter.js');
const { normalizeSegments } = require('../dist/server/normalizer.js');
const norm = { enabled: true, toSimplified: true, terms: {} };

const oldWay = segments.map((s) => ({ ...s, text: punctuate(s.text) }));
const newWay = normalizeSegments(splitByPause(segments, words, DEFAULT_SPLIT), norm);

function metrics(list, label) {
  const durs = list.map((s) => s.end - s.start);
  const chars = list.map((s) => s.text.length);
  const tooLong = list.filter((s) => s.text.length > 80).length;
  const noPunct = list.filter((s) => s.text.length > 25 && !/[，。！？]/.test(s.text)).length;
  const commas = list.reduce((a, s) => a + (s.text.match(/[，。！？]/g) || []).length, 0);
  console.log(`\n=== ${label} ===`);
  console.log(`  段落数        ${list.length}`);
  console.log(`  最长段        ${Math.max(...durs).toFixed(1)}s`);
  console.log(`  最长段字数    ${Math.max(...chars)}`);
  console.log(`  平均字数      ${(chars.reduce((a, b) => a + b, 0) / list.length).toFixed(1)}`);
  console.log(`  >80字的段     ${tooLong} 个`);
  console.log(`  >25字无标点   ${noPunct} 个`);
  console.log(`  标点总数      ${commas}`);
}

metrics(oldWay, '旧逻辑（只补标点）');
metrics(newWay, '新逻辑（合并+词重建+停顿切分）');

// 抽查最长的三段
console.log('\n=== 新逻辑下最长的 3 段 ===');
for (const s of [...newWay].sort((a, b) => b.text.length - a.text.length).slice(0, 3)) {
  console.log(`  [${(s.end - s.start).toFixed(1)}s / ${s.text.length}字] ${s.text.slice(0, 90)}`);
}
