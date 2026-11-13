'use strict';
/** 看 min_duration_off 前后的段落归属。 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeAsrResponse } = require('../dist/server/asrClient.js');
const { splitByPause, DEFAULT_SPLIT } = require('../dist/server/segmenter.js');
const { normalizeSegments } = require('../dist/server/normalizer.js');

const cases = [
  { label: '2人 (md=2.0)', file: 'a8-md2.json' },
  { label: '3人 (md=2.0)', file: 'a8-md2-n3.json' },
];

const norm = { enabled: true, toSimplified: true, terms: {} };

for (const c of cases) {
  const p = path.join(process.env.TEMP, c.file);
  if (!fs.existsSync(p)) {
    console.log(`\n### ${c.label}：缺文件 ${c.file}`);
    continue;
  }
  const res = normalizeAsrResponse(JSON.parse(fs.readFileSync(p, 'utf8')));
  const out = normalizeSegments(splitByPause(res.segments, res.words, DEFAULT_SPLIT), norm);
  const durs = out.map((s) => s.end - s.start);
  console.log(`\n### ${c.label}：${out.length} 段，中位 ${durs.sort((a, b) => a - b)[Math.floor(durs.length / 2)].toFixed(1)}s`);
  for (const s of out) {
    console.log(`  [${s.start.toFixed(0).padStart(3)}s] ${(s.speaker || '-').padEnd(11)} ${s.text.slice(0, 40)}`);
  }
}
