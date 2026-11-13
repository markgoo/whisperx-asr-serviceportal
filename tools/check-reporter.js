'use strict';
/** 对比 3 人和 4 人的内容归属，重点看记者的提问是否归到同一个 speaker。 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeAsrResponse } = require('../dist/server/asrClient.js');
const { splitByPause, DEFAULT_SPLIT } = require('../dist/server/segmenter.js');
const { normalizeSegments } = require('../dist/server/normalizer.js');

const cases = [
  { label: '3 人', file: 'a8-n3.json' },
  { label: '4 人', file: 'a8-n4.json' },
];

const norm = { enabled: true, toSimplified: true, terms: {} };

// 这些是记者的话，理想情况下应归到同一个 speaker
const REPORTER_CUES = ['能不能帮我们', '介绍一下', '为什么选在', '还有什么故事', '谢谢你们', '你们好'];

for (const c of cases) {
  const p = path.join(process.env.TEMP, c.file);
  if (!fs.existsSync(p)) {
    console.log(`\n### ${c.label}: 缺文件`);
    continue;
  }
  const res = normalizeAsrResponse(JSON.parse(fs.readFileSync(p, 'utf8')));
  const out = normalizeSegments(splitByPause(res.segments, res.words, DEFAULT_SPLIT), norm);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`### ${c.label}：${out.length} 段`);
  for (const s of out) {
    const isReporter = REPORTER_CUES.some((k) => s.text.includes(k));
    const mark = isReporter ? ' ★记者' : '';
    console.log(`[${s.start.toFixed(0).padStart(3)}s] ${(s.speaker || '-').padEnd(11)} ${s.text.slice(0, 38)}${mark}`);
  }

  // 统计记者线索落在几个 speaker 上
  const reporterSpeakers = new Set();
  for (const s of out) {
    if (REPORTER_CUES.some((k) => s.text.includes(k))) reporterSpeakers.add(s.speaker);
  }
  console.log(`\n→ 记者线索落在 ${reporterSpeakers.size} 个 speaker 上: ${[...reporterSpeakers].join(', ')}`);
  console.log(reporterSpeakers.size === 1 ? '   ✓ 记者被归到同一个人，分离正确' : '   ✗ 记者被拆到多个人，分离错误');
}
