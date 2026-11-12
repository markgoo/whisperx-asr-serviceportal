/**
 * 本地联调用的模拟 WhisperX ASR 服务。
 * 只实现门户需要的接口：GET /health、POST /asr（multipart）。
 * 返回带说话人区分的假转写结果，用来验证门户的端到端流程。
 *
 * 用法：node tools/mock-asr.js [port]
 */
'use strict';
const http = require('node:http');

const PORT = Number(process.argv[2] || 9000);

const SPEAKERS = ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02'];
const SENTENCES = [
  '大家好，我们开始今天的会议。',
  '好的，我先说一下这周的进展。',
  '这一版的设计已经完成，剩下的主要是测试。',
  '我这边有一个问题，接口的响应时间偏慢。',
  '那我们把缓存加上，下周再看数据。',
  '没问题，我负责跟进这一块。',
  '另外提醒一下，周五之前要提交周报。',
  '明白，我记下了。',
];

function fakeResult(seconds) {
  const segments = [];
  let t = 0;
  let i = 0;
  while (t < Math.min(seconds || 60, 600)) {
    const dur = 3 + (i % 4);
    segments.push({
      start: Number(t.toFixed(2)),
      end: Number((t + dur).toFixed(2)),
      text: SENTENCES[i % SENTENCES.length],
      speaker: SPEAKERS[Math.floor(i / 3) % SPEAKERS.length],
    });
    t += dur + 0.4;
    i += 1;
  }
  return {
    text: segments,
    language: 'zh',
    segments,
    word_segments: [],
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', device: 'mock', loaded_models: ['large-v3'], serve_mode: 'simple' }));
  }

  if (req.method === 'POST' && url.pathname === '/asr') {
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
    });
    req.on('end', () => {
      const params = url.searchParams;
      console.log(
        `[mock-asr] /asr diarize=${params.get('diarize')} model=${params.get('model') || '(default)'} ` +
          `min=${params.get('min_speakers') || '-'} max=${params.get('max_speakers') || '-'} size=${(bytes / 1024).toFixed(0)}KB`,
      );
      // Simulate a little GPU time so the portal's polling UI is visible.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fakeResult(120)));
      }, 2500);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-asr] listening on http://127.0.0.1:${PORT}`);
});
