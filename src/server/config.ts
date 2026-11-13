import path from 'node:path';
import fs from 'node:fs';

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Root of the project (dist/server/../../). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const PORT = envInt('PORT', 8080);
export const HOST = envStr('HOST', '0.0.0.0');

/** Where user data (db, uploads) lives. Kept outside dist/ so rebuilds never wipe it. */
export const DATA_DIR = path.resolve(envStr('DATA_DIR', path.join(PROJECT_ROOT, 'data')));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'portal.db');
/** Alias used by the UI when telling the operator where data lives. */
export const DATABASE_FILE = DB_PATH;
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

/** Default ASR backend. Can be overridden at runtime from the settings page. */
export const DEFAULT_ASR_BASE_URL = envStr('ASR_BASE_URL', 'http://127.0.0.1:9000');

/**
 * 标点恢复服务的默认地址。
 * 在 Docker 里必须用服务名（http://punc:9001），容器内的 127.0.0.1
 * 指向容器自己，连不到别的容器。
 */
export const DEFAULT_PUNC_SERVICE_URL = envStr('PUNC_SERVICE_URL', 'http://127.0.0.1:9001');

/** First-run super administrator. */
export const SEED_ADMIN_USERNAME = envStr('ADMIN_USERNAME', 'admin');
export const SEED_ADMIN_PASSWORD = envStr('ADMIN_PASSWORD', 'admin123');

/** Max upload size in MB (0 = unlimited). Mirrors the ASR service MAX_FILE_SIZE_MB default. */
export const MAX_UPLOAD_MB = envInt('MAX_UPLOAD_MB', 1000);

/** How many transcription jobs may run at once against the ASR backend. */
export const WORKER_CONCURRENCY = Math.max(1, envInt('WORKER_CONCURRENCY', 1));

/** Session lifetime in days. */
export const SESSION_DAYS = Math.max(1, envInt('SESSION_DAYS', 14));

export const ALLOWED_AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.mp4', '.flac', '.ogg', '.oga', '.opus',
  '.webm', '.aac', '.wma', '.aiff', '.aif', '.amr', '.mkv', '.mov', '.m4v',
]);

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, UPLOAD_DIR, PUBLIC_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
