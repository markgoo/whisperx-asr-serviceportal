import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, DEFAULT_ASR_BASE_URL, SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD, ensureDirs } from './config';
import { hashPassword } from './password';
import { nowIso } from './util';
import type { AppSettings, UserRow } from './types';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  user_agent TEXT    NOT NULL DEFAULT '',
  ip         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'queued',
  stage           TEXT    NOT NULL DEFAULT '等待处理',
  progress        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  file_id         TEXT,
  original_name   TEXT    NOT NULL DEFAULT '',
  storage_path    TEXT,
  file_size       INTEGER NOT NULL DEFAULT 0,
  mime_type       TEXT    NOT NULL DEFAULT '',
  duration        REAL,
  -- 说话人分离（默认开启）
  diarize         INTEGER NOT NULL DEFAULT 1,
  num_speakers    INTEGER,
  min_speakers    INTEGER,
  max_speakers    INTEGER,
  -- 转写参数
  language        TEXT,
  model           TEXT,
  task_type       TEXT    NOT NULL DEFAULT 'transcribe',
  initial_prompt  TEXT,
  hotwords        TEXT,
  word_timestamps INTEGER NOT NULL DEFAULT 1,
  -- 结果
  result_text     TEXT,
  result_json     TEXT,
  segment_count   INTEGER NOT NULL DEFAULT 0,
  speaker_count   INTEGER NOT NULL DEFAULT 0,
  -- 说话人显示名映射：{"SPEAKER_00":"张三"}
  speaker_names   TEXT    NOT NULL DEFAULT '{}',
  detected_lang   TEXT,
  -- 时间线
  created_at      TEXT    NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  elapsed_ms      INTEGER,
  retry_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

export function initDb(): void {
  ensureDirs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();
  seedDefaultSettings();
  seedAdmin();
  recoverInterruptedTasks();
}

/**
 * 增量迁移：老版本数据库缺的列在这里补上。
 * SQLite 的 ADD COLUMN 很快，且不会动已有数据。
 */
function migrate(): void {
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const has = (name: string): boolean => columns.some((c) => c.name === name);
  if (!has('speaker_names')) {
    // 说话人显示名映射，形如 {"SPEAKER_00":"张三"}
    db.exec("ALTER TABLE tasks ADD COLUMN speaker_names TEXT NOT NULL DEFAULT '{}'");
    console.log('[portal] 已为 tasks 表添加 speaker_names 列');
  }
}

function seedDefaultSettings(): void {
  const defaults: Record<string, string> = {
    asr_base_url: DEFAULT_ASR_BASE_URL,
    asr_timeout_sec: '7200',
    default_model: '',
    default_diarize: '1',
    default_min_speakers: '',
    default_max_speakers: '',
    storage_retain_days: '0',
    storage_quota_mb: '0',
    allow_registration: '0',
    normalize_enabled: '1',
    normalize_s2t: '1',
    normalize_terms: '',
    split_enabled: '1',
    split_pause_sec: '0.45',
  };
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
  });
  tx();
}

function seedAdmin(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 'superadmin', 'active', ?, ?)`,
  ).run(SEED_ADMIN_USERNAME, '超级管理员', hashPassword(SEED_ADMIN_PASSWORD), now, now);
  // eslint-disable-next-line no-console
  console.log(`[portal] 已创建默认超级管理员：${SEED_ADMIN_USERNAME} / ${SEED_ADMIN_PASSWORD}`);
}

/**
 * Jobs that were running or queued when the process died stay in a half-finished
 * state forever otherwise. Mark them failed so the user can retry deliberately.
 */
function recoverInterruptedTasks(): void {
  const now = nowIso();
  const res = db
    .prepare(
      `UPDATE tasks
          SET status = 'failed',
              stage = '已中断',
              error_message = '服务重启导致任务中断，请重试',
              finished_at = ?
        WHERE status IN ('queued', 'processing')`,
    )
    .run(now);
  if (res.changes > 0) {
    console.log(`[portal] ${res.changes} 个未完成任务已标记为中断`);
  }
}

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getSettings(): AppSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string, d: number): number => {
    const n = Number.parseInt(map.get(k) ?? '', 10);
    return Number.isFinite(n) ? n : d;
  };
  return {
    asrBaseUrl: map.get('asr_base_url') || DEFAULT_ASR_BASE_URL,
    asrTimeoutSec: num('asr_timeout_sec', 7200),
    defaultModel: map.get('default_model') ?? '',
    defaultDiarize: (map.get('default_diarize') ?? '1') === '1',
    defaultMinSpeakers: map.get('default_min_speakers') || '',
    defaultMaxSpeakers: map.get('default_max_speakers') || '',
    storageRetainDays: num('storage_retain_days', 0),
    storageQuotaMb: num('storage_quota_mb', 0),
    allowRegistration: (map.get('allow_registration') ?? '0') === '1',
    normalizeEnabled: (map.get('normalize_enabled') ?? '1') === '1',
    normalizeToSimplified: (map.get('normalize_s2t') ?? '1') === '1',
    normalizeTerms: map.get('normalize_terms') ?? '',
    splitEnabled: (map.get('split_enabled') ?? '1') === '1',
    splitPauseSec: Number.parseFloat(map.get('split_pause_sec') ?? '0.45') || 0.45,
  };
}

export function findUserByUsername(username: string): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function countActiveSuperadmins(excludeUserId = 0): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM users
          WHERE role = 'superadmin' AND status = 'active' AND id <> ?`,
      )
      .get(excludeUserId) as { c: number }
  ).c;
}

export function audit(userId: number | null, username: string, action: string, detail = ''): void {
  db.prepare(
    'INSERT INTO audit_log (user_id, username, action, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, username, action, detail, nowIso());
}
