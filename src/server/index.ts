import express from 'express';
import path from 'node:path';
import { HOST, PORT, PUBLIC_DIR, UPLOAD_DIR, DATABASE_FILE, MAX_UPLOAD_MB, WORKER_CONCURRENCY, ensureDirs } from './config';
import { initDb, getSetting } from './db';
import { api } from './routes';
import { attachUser, purgeExpiredSessions } from './auth';
import { startWorker, stopWorker } from './worker';
import { HttpError } from './util';

ensureDirs();
initDb();
purgeExpiredSessions();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(attachUser);

// Static assets. 这是本地工具，前端改动必须刷新即生效，
// 所以一律不缓存（否则用户会看到改之前的旧界面）。
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }),
);

app.use('/api', api);

// Single page app fallback.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Central error handler: HttpError -> its status, everything else -> 500.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  const e = err as { code?: string; message?: string };
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `文件超过大小上限（${MAX_UPLOAD_MB} MB）`,
      code: 'file_too_large',
    });
  }
  if (e?.message && /不支持的音频格式/.test(e.message)) {
    return res.status(400).json({ error: e.message, code: 'bad_format' });
  }
  // eslint-disable-next-line no-console
  console.error('[portal] 未处理的错误:', err);
  res.status(500).json({ error: e?.message || '服务器内部错误', code: 'internal_error' });
});

const server = app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  // eslint-disable-next-line no-console
  console.log('──────────────────────────────────────────────');
  console.log(`  WhisperX ASR 门户已启动`);
  console.log(`  访问地址: http://${shown}:${PORT}`);
  console.log(`  ASR 后端: ${getSetting('asr_base_url')}`);
  console.log(`  上传目录: ${UPLOAD_DIR}`);
  console.log(`  数据库:   ${DATABASE_FILE}`);
  console.log(`  并发上限: ${WORKER_CONCURRENCY}`);
  console.log('──────────────────────────────────────────────');
  startWorker();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[portal] 端口 ${PORT} 已被占用。`);
    console.error(`         可能已经有一个门户实例在运行，先关掉它，或换一个端口：`);
    console.error(`             set PORT=8081 && npm start`);
    console.error('');
  } else {
    console.error('[portal] 服务器启动失败:', err.message);
  }
  process.exit(1);
});

server.requestTimeout = 0; // audio uploads may legitimately take minutes
server.headersTimeout = 0;

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[portal] 收到 ${signal}，正在停止...`);
  stopWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[portal] 未处理的 Promise 拒绝:', reason);
});
