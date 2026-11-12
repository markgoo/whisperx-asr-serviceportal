'use strict';
/** 用真实转写结果对比新旧分段逻辑。 */
const fs = require('node:fs');
const path = require('node:path');

const raw = JSON.parse(fs.readFileSync(path.join(process.env.TEMP, 'seg-result.json'), 'utf8'));
const segments = raw.segments || [];
const words = raw.word_segments || [];

const { splitByPause, DEFAULT_SPLIT, punctuate } = require('../dist/server/segmenter.js');
const { normalizeSegments } = require('../dist/server/normalizer.js');

const norm = { enabled: true, toSimplified: true, terms: {} };

console.log('=== 原始 whisper 分段（前 12 段）===');
for (const s of segments.slice(0, 12)) {
  console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${(s.end - s.start).toFixed(1)}s ${s.text.slice(0, 50)}`);
}

const oldWay = segments.map((s) => ({ ...s, text: punctuate(s.text) }));
const newWay = normalizeSegments(splitByPause(segments, words, DEFAULT_SPLIT), norm);

console.log('\n=== 旧逻辑（只补标点，保留 whisper 分段）===');
for (const s of oldWay.slice(0, 8)) {
  console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
}

console.log('\n=== 新逻辑（合并同人相邻段 + 词重建 + 停顿重切）===');
for (const s of newWay.slice(0, 10)) {
  console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
}

// 找「什么」被切断的情况
const checkWordSplit = (list, label) => {
  const joined = list.map((s) => s.text).join('|');
  const bad = [];
  for (const w of ['什么', '这个', '所以', '我们', '可以', '不是']) {
    if (joined.includes(`${w[0]}|`) || joined.includes(`|${w.slice(1)}`)) bad.push(w);
  }
  console.log(`\n${label} 疑似被切断的词: ${bad.length ? bad.join(', ') : '无'}`);
};
checkWordSplit(oldWay, '旧逻辑');
checkWordSplit(newWay, '新逻辑');

const oldDur = oldWay.map((s) => s.end - s.start).sort((a, b) => b - a);
const newDur = newWay.map((s) => s.end - s.start).sort((a, b) => b - a);
console.log(`\n段落数：旧 ${oldWay.length} → 新 ${newWay.length}`);
console.log(`最长段：旧 ${oldDur[0].toFixed(1)}s → 新 ${newDur[0].toFixed(1)}s`);
console.log(`中位段：旧 ${oldDur[Math.floor(oldDur.length / 2)].toFixed(1)}s → 新 ${newDur[Math.floor(newDur.length / 2)].toFixed(1)}s`);
