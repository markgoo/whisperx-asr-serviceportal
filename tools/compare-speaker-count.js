'use strict';
/** 对比不同说话人数设置下，按词级 speaker 切分的效果。 */
const fs = require('node:fs');
const path = require('node:path');

const { normalizeAsrResponse } = require('../dist/server/asrClient.js');
const { splitByPause, DEFAULT_SPLIT } = require('../dist/server/segmenter.js');
const { normalizeSegments } = require('../dist/server/normalizer.js');

const files = [
  { label: '自动判断', file: 'a8-auto.json' },
  { label: '指定2人', file: 'a8-n2.json' },
  { label: '指定3人', file: 'a8-n3.json' },
];

const norm = { enabled: true, toSimplified: true, terms: {} };

for (const f of files) {
  const p = path.join(process.env.TEMP, f.file);
  if (!fs.existsSync(p)) {
    console.log(`\n### ${f.label}：文件缺失`);
    continue;
  }
  const res = normalizeAsrResponse(JSON.parse(fs.readFileSync(p, 'utf8')));
  const out = normalizeSegments(splitByPause(res.segments, res.words, DEFAULT_SPLIT), norm);
  const speakers = [...new Set(out.map((s) => s.speaker).filter(Boolean))];

  console.log(`\n### ${f.label}：${out.length} 段 / ${speakers.length} 人`);
  for (const s of out.slice(0, 14)) {
    console.log(
      `  [${s.start.toFixed(1).padStart(6)}] ${(s.speaker || '-').padEnd(11)} ${s.text.slice(0, 40)}`,
    );
  }
}
