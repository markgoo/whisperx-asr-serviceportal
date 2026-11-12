import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_AUDIO_EXTENSIONS, DATABASE_FILE, MAX_UPLOAD_MB, SESSION_DAYS, UPLOAD_DIR } from './config';
import {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  destroySession,
  destroyUserSessions,
  requireAdmin,
  requireAuth,
  requireSuperadmin,
  toPublicUser,
  type AuthedRequest,
} from './auth';
import {
  audit,
  countActiveSuperadmins,
  findUserById,
  findUserByUsername,
  getDb,
  getSettings,
  setSetting,
} from './db';
import { hashPassword, validatePasswordStrength, validateUsername, verifyPassword } from './password';
import {
  HttpError,
  asyncHandler,
  badRequest,
  boolish,
  clamp,
  conflict,
  forbidden,
  formatBytes,
  notFound,
  nowIso,
  optionalInt,
  str,
  toInt,
  unauthorized,
} from './util';
import { buildSpeakerLines, safeParseSegments, safeParseSpeakerNames, toTaskDetailDto, toTaskDto } from './mappers';
import { normalizeSegments, normalizeText, parseTermsText } from './normalizer';
import {
  assertInsideUploads,
  deleteFileSafe,
  diskUsage,
  fileExists,
  fileSizeSafe,
  newFileId,
  userUploadDir,
} from './storage';
import { loadTaskFor, requireUser } from './tasks-service';
import { cancelTask, enqueue, isRunning } from './worker';
import { checkAsrHealth } from './asrClient';
import type { AppSettings, PublicUser, StorageItem, TaskRow, UserRow } from './types';

export const api = express.Router();

type Scoped = { sql: string; params: unknown[] };

/** SQL fragment limiting rows to what the signed-in user may see. */
function scopeOf(user: UserRow, alias = ''): Scoped {
  const p = alias ? `${alias}.` : '';
  if (user.role === 'admin' || user.role === 'superadmin') return { sql: '', params: [] };
  return { sql: `${p}user_id = ?`, params: [user.id] };
}

function ownerName(userId: number): string {
  const row = findUserById(userId);
  return row ? row.display_name || row.username : `用户#${userId}`;
}

function toStorageItem(row: TaskRow): StorageItem {
  return {
    id: row.file_id || `task-${row.id}`,
    taskId: row.id,
    fileName: row.original_name,
    size: row.file_size,
    uploadedAt: row.created_at,
    ownerId: row.user_id,
    ownerName: ownerName(row.user_id),
    title: row.title,
    status: row.status,
  };
}

/** Every file under `root` that no task row references. */
function findOrphans(root: string): { path: string; size: number }[] {
  const referenced = new Set(
    (getDb().prepare('SELECT storage_path FROM tasks WHERE storage_path IS NOT NULL').all() as {
      storage_path: string;
    }[]).map((r) => path.resolve(r.storage_path)),
  );
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !referenced.has(path.resolve(full))) {
        out.push({ path: full, size: fileSizeSafe(full) });
      }
    }
  };
  walk(root);
  return out;
}

function storageRoot(user: UserRow): string {
  return user.role === 'admin' || user.role === 'superadmin'
    ? UPLOAD_DIR
    : path.join(UPLOAD_DIR, String(user.id));
}

/** Bytes currently occupied by stored audio (scoped to the caller). */
function usedBytes(user: UserRow): number {
  const s = scopeOf(user, 't');
  const sql = `SELECT COALESCE(SUM(t.file_size),0) AS b FROM tasks t ${s.sql ? `WHERE ${s.sql}` : ''}`;
  return (getDb().prepare(sql).get(...s.params) as { b: number }).b;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

api.post(
  '/auth/login',
  asyncHandler(async (req: AuthedRequest, res) => {
    const username = str(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) throw badRequest('请输入用户名和密码');

    const user = findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('用户名或密码错误');
    }
    if (user.status !== 'active') throw forbidden('账号已被禁用，请联系管理员');

    const ip = String(req.ip || req.socket.remoteAddress || '');
    const { token, expiresAt } = createSession(user.id, SESSION_DAYS, String(req.headers['user-agent'] || ''), ip);
    const now = nowIso();
    getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
    audit(user.id, user.username, 'login', ip);

    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(new Date(expiresAt).getTime() - Date.now())}`,
    );
    res.json({
      user: toPublicUser({ ...user, last_login_at: now }),
      settings: publicSettings(getSettings(), { ...user, last_login_at: now }),
    });
  }),
);

api.post(
  '/auth/logout',
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.sessionToken) destroySession(req.sessionToken);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(0)}`);
    res.json({ ok: true });
  }),
);

api.get(
  '/auth/me',
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) throw unauthorized();
    res.json({ user: toPublicUser(req.user), settings: publicSettings(getSettings(), req.user) });
  }),
);

api.post(
  '/auth/password',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const row = findUserById(user.id)!;
    if (!verifyPassword(current, row.password_hash)) throw badRequest('当前密码不正确');
    const problem = validatePasswordStrength(next);
    if (problem) throw badRequest(problem);
    getDb()
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), nowIso(), user.id);
    destroyUserSessions(user.id, req.sessionToken);
    audit(user.id, user.username, 'change_password');
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

api.get(
  '/users',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT u.*,
                (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) AS task_count,
                (SELECT COALESCE(SUM(t.file_size),0) FROM tasks t WHERE t.user_id = u.id) AS storage_bytes
           FROM users u ORDER BY u.id ASC`,
      )
      .all() as (UserRow & { task_count: number; storage_bytes: number })[];
    const users: PublicUser[] = rows.map((r) =>
      toPublicUser(r, { taskCount: r.task_count, storageBytes: r.storage_bytes }),
    );
    res.json({ users });
  }),
);

api.post(
  '/users',
  requireAdmin,
  asyncHandler(async (req: AuthedRequest, res) => {
    const actor = requireUser(req);
    const username = str(req.body?.username);
    const displayName = str(req.body?.displayName) || username;
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = str(req.body?.role) || 'user';

    const usernameProblem = validateUsername(username);
    if (usernameProblem) throw badRequest(usernameProblem);
    const passwordProblem = validatePasswordStrength(password);
    if (passwordProblem) throw badRequest(passwordProblem);
    if (!['user', 'admin', 'superadmin'].includes(role)) throw badRequest('角色不合法');
    if (role !== 'user' && actor.role !== 'superadmin') {
      throw forbidden('只有超级管理员可以创建管理员账号');
    }
    if (findUserByUsername(username)) throw conflict('用户名已存在');

    const now = nowIso();
    const info = getDb()
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(username, displayName, hashPassword(password), role, now, now);
    audit(actor.id, actor.username, 'user_create', `${username} (${role})`);
    res.status(201).json({ user: toPublicUser(findUserById(Number(info.lastInsertRowid))!) });
  }),
);

api.patch(
  '/users/:id',
  requireAdmin,
  asyncHandler(async (req: AuthedRequest, res) => {
    const actor = requireUser(req);
    const target = findUserById(toInt(req.params.id, 0));
    if (!target) throw notFound('用户不存在');
    if (target.role === 'superadmin' && actor.role !== 'superadmin') {
      throw forbidden('只有超级管理员可以修改超级管理员');
    }

    const patch: Record<string, unknown> = {};
    if (req.body?.displayName !== undefined) {
      patch.display_name = str(req.body.displayName) || target.username;
    }
    if (req.body?.role !== undefined) {
      const role = str(req.body.role);
      if (!['user', 'admin', 'superadmin'].includes(role)) throw badRequest('角色不合法');
      if (role !== 'user' && actor.role !== 'superadmin') {
        throw forbidden('只有超级管理员可以授予管理员权限');
      }
      if (target.role === 'superadmin' && role !== 'superadmin' && countActiveSuperadmins(target.id) === 0) {
        throw badRequest('至少要保留一个超级管理员');
      }
      patch.role = role;
    }
    if (req.body?.status !== undefined) {
      const status = str(req.body.status);
      if (!['active', 'disabled'].includes(status)) throw badRequest('状态不合法');
      if (status !== 'active' && target.role === 'superadmin' && countActiveSuperadmins(target.id) === 0) {
        throw badRequest('不能禁用最后一个超级管理员');
      }
      patch.status = status;
    }
    let passwordChanged = false;
    if (typeof req.body?.password === 'string' && req.body.password !== '') {
      const problem = validatePasswordStrength(req.body.password);
      if (problem) throw badRequest(problem);
      patch.password_hash = hashPassword(req.body.password);
      passwordChanged = true;
    }

    if (!Object.keys(patch).length) return res.json({ user: toPublicUser(target) });
    patch.updated_at = nowIso();
    const keys = Object.keys(patch);
    getDb()
      .prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k]), target.id);

    if (patch.status === 'disabled') destroyUserSessions(target.id);
    if (passwordChanged) destroyUserSessions(target.id);

    audit(actor.id, actor.username, 'user_update', `${target.username}: ${keys.join(',')}`);
    res.json({ user: toPublicUser(findUserById(target.id)!) });
  }),
);

api.delete(
  '/users/:id',
  requireSuperadmin,
  asyncHandler(async (req: AuthedRequest, res) => {
    const actor = requireUser(req);
    const targetId = toInt(req.params.id, 0);
    if (targetId === actor.id) throw badRequest('不能删除自己');
    const target = findUserById(targetId);
    if (!target) throw notFound('用户不存在');
    if (target.role === 'superadmin' && countActiveSuperadmins(target.id) === 0) {
      throw badRequest('至少要保留一个超级管理员');
    }

    const files = getDb()
      .prepare('SELECT storage_path FROM tasks WHERE user_id = ?')
      .all(targetId) as { storage_path: string | null }[];
    for (const f of files) deleteFileSafe(f.storage_path);
    try {
      fs.rmSync(path.join(UPLOAD_DIR, String(targetId)), { recursive: true, force: true });
    } catch {
      /* best effort */
    }

    getDb().prepare('DELETE FROM users WHERE id = ?').run(targetId);
    audit(actor.id, actor.username, 'user_delete', target.username);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function publicSettings(settings: AppSettings, user: UserRow) {
  const admin = user.role === 'admin' || user.role === 'superadmin';
  return {
    ...settings,
    canManageUsers: admin,
    canManageSettings: admin,
    isSuperadmin: user.role === 'superadmin',
    role: user.role,
  };
}

api.get(
  '/settings',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ settings: publicSettings(getSettings(), requireUser(req)) });
  }),
);

api.put(
  '/settings',
  requireAdmin,
  asyncHandler(async (req: AuthedRequest, res) => {
    const actor = requireUser(req);
    const body = req.body ?? {};
    if (body.asrBaseUrl !== undefined) {
      const url = str(body.asrBaseUrl);
      if (!/^https?:\/\/.+/i.test(url)) throw badRequest('ASR 地址需要以 http:// 或 https:// 开头');
      setSetting('asr_base_url', url.replace(/\/+$/, ''));
    }
    if (body.asrTimeoutSec !== undefined) {
      setSetting('asr_timeout_sec', String(clamp(toInt(body.asrTimeoutSec, 7200), 30, 86400)));
    }
    if (body.defaultModel !== undefined) setSetting('default_model', str(body.defaultModel));
    if (body.defaultDiarize !== undefined) {
      setSetting('default_diarize', boolish(body.defaultDiarize, true) ? '1' : '0');
    }
    if (body.defaultMinSpeakers !== undefined) {
      const v = optionalInt(body.defaultMinSpeakers);
      setSetting('default_min_speakers', v === null ? '' : String(clamp(v, 1, 32)));
    }
    if (body.defaultMaxSpeakers !== undefined) {
      const v = optionalInt(body.defaultMaxSpeakers);
      setSetting('default_max_speakers', v === null ? '' : String(clamp(v, 1, 32)));
    }
    if (body.storageRetainDays !== undefined) {
      setSetting('storage_retain_days', String(clamp(toInt(body.storageRetainDays, 0), 0, 3650)));
    }
    if (body.storageQuotaMb !== undefined) {
      setSetting('storage_quota_mb', String(clamp(toInt(body.storageQuotaMb, 0), 0, 10_000_000)));
    }
    if (body.allowRegistration !== undefined) {
      setSetting('allow_registration', boolish(body.allowRegistration, false) ? '1' : '0');
    }
    if (body.normalizeEnabled !== undefined) {
      setSetting('normalize_enabled', boolish(body.normalizeEnabled, true) ? '1' : '0');
    }
    if (body.normalizeToSimplified !== undefined) {
      setSetting('normalize_s2t', boolish(body.normalizeToSimplified, true) ? '1' : '0');
    }
    if (body.normalizeTerms !== undefined) {
      const terms = String(body.normalizeTerms ?? '');
      if (terms.length > 200_000) throw badRequest('术语词典过大');
      setSetting('normalize_terms', terms);
    }
    audit(actor.id, actor.username, 'settings_update');
    res.json({ settings: publicSettings(getSettings(), actor) });
  }),
);

api.get(
  '/asr/health',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const settings = getSettings();
    const health = await checkAsrHealth(settings.asrBaseUrl);
    res.json({ ...health, baseUrl: settings.asrBaseUrl });
  }),
);

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/**
 * multer/busboy 把 multipart 里的文件名按 latin1 解码，中文名会变成乱码。
 * 这里还原成 UTF-8；如果本来就是 ASCII 则原样返回。
 */
function decodeUploadName(raw: string): string {
  if (!raw) return raw;
  if (!/[\u0080-\u00ff]/.test(raw)) return raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  // 还原失败会得到替换字符，这时保留原名。
  return decoded.includes('\uFFFD') ? raw : decoded;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const user = (req as AuthedRequest).user;
      if (!user) return cb(new Error('未登录'), '');
      cb(null, userUploadDir(user.id));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(decodeUploadName(file.originalname)).toLowerCase();
      cb(null, `${newFileId()}${ext || '.bin'}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB > 0 ? MAX_UPLOAD_MB * 1024 * 1024 : undefined },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(decodeUploadName(file.originalname)).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
      return cb(new Error(`不支持的音频格式：${ext || '(无扩展名)'}`));
    }
    cb(null, true);
  },
});

api.post(
  '/tasks',
  requireAuth,
  upload.single('audio'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const file = req.file;
    if (!file) throw badRequest('请选择要转写的音频文件');

    const settings = getSettings();
    if (settings.storageQuotaMb > 0) {
      const used = usedBytes(user);
      if (used + file.size > settings.storageQuotaMb * 1024 * 1024) {
        deleteFileSafe(file.path);
        throw new HttpError(
          413,
          `存储空间不足：已用 ${formatBytes(used)}，上限 ${settings.storageQuotaMb} MB`,
          'quota_exceeded',
        );
      }
    }

    const body = req.body ?? {};
    const diarize = boolish(body.diarize, settings.defaultDiarize);
    let minSpeakers = optionalInt(body.minSpeakers);
    let maxSpeakers = optionalInt(body.maxSpeakers);
    if (diarize) {
      if (minSpeakers !== null) minSpeakers = clamp(minSpeakers, 1, 32);
      if (maxSpeakers !== null) maxSpeakers = clamp(maxSpeakers, 1, 32);
      if (minSpeakers !== null && maxSpeakers !== null && minSpeakers > maxSpeakers) {
        // 参数不合法时把刚落盘的文件一起删掉，避免留下孤儿文件
        deleteFileSafe(file.path);
        throw badRequest('最小说话人数不能大于最大说话人数');
      }
    } else {
      minSpeakers = null;
      maxSpeakers = null;
    }

    const originalName = decodeUploadName(file.originalname);
    const title = (str(body.title) || path.parse(originalName).name || '未命名任务').slice(0, 200);
    const info = getDb()
      .prepare(
        `INSERT INTO tasks (
           user_id, title, status, stage, progress, file_id, original_name, storage_path,
           file_size, mime_type, diarize, min_speakers, max_speakers, language, model, task_type,
           initial_prompt, hotwords, word_timestamps, created_at
         ) VALUES (?, ?, 'queued', '排队中', 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        title,
        path.basename(file.path, path.extname(file.path)),
        originalName,
        file.path,
        file.size,
        file.mimetype || 'application/octet-stream',
        diarize ? 1 : 0,
        minSpeakers,
        maxSpeakers,
        str(body.language) || null,
        str(body.model) || null,
        str(body.taskType) === 'translate' ? 'translate' : 'transcribe',
        str(body.initialPrompt) || null,
        str(body.hotwords) || null,
        boolish(body.wordTimestamps, true) ? 1 : 0,
        nowIso(),
      );

    const taskId = Number(info.lastInsertRowid);
    audit(user.id, user.username, 'task_create', `#${taskId} ${title} (${originalName})`);
    enqueue();
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow;
    res.status(201).json({ task: toTaskDto(row, user.display_name || user.username) });
  }),
);

api.get(
  '/tasks',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const page = Math.max(1, toInt(req.query.page, 1));
    const pageSize = clamp(toInt(req.query.pageSize, 20), 1, 100);
    const status = str(req.query.status);
    const search = str(req.query.search);
    const scope = str(req.query.scope) || 'all';
    const ownerFilter = optionalInt(req.query.ownerId);

    const isAdminUser = user.role === 'admin' || user.role === 'superadmin';
    const where: string[] = [];
    const params: unknown[] = [];
    if (!isAdminUser) {
      where.push('t.user_id = ?');
      params.push(user.id);
    } else if (scope === 'mine') {
      where.push('t.user_id = ?');
      params.push(user.id);
    } else if (ownerFilter) {
      where.push('t.user_id = ?');
      params.push(ownerFilter);
    }
    if (status && ['queued', 'processing', 'completed', 'failed', 'canceled'].includes(status)) {
      where.push('t.status = ?');
      params.push(status);
    }
    if (search) {
      where.push('(t.title LIKE ? OR t.original_name LIKE ? OR COALESCE(t.result_text, "") LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const db = getDb();
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM tasks t ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db
      .prepare(
        `SELECT t.* FROM tasks t ${whereSql}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as TaskRow[];

    const counts = db
      .prepare(`SELECT t.status AS s, COUNT(*) AS c FROM tasks t ${whereSql} GROUP BY t.status`)
      .all(...params) as { s: string; c: number }[];
    const byStatus: Record<string, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    for (const c of counts) byStatus[c.s] = c.c;

    res.json({
      tasks: rows.map((r) => toTaskDto(r, ownerName(r.user_id))),
      total,
      page,
      pageSize,
      byStatus,
    });
  }),
);

api.get(
  '/tasks/:id',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    res.json({ task: toTaskDetailDto(task, ownerName(task.user_id)) });
  }),
);

api.patch(
  '/tasks/:id',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    const title = str(req.body?.title);
    if (!title) throw badRequest('标题不能为空');
    getDb().prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title.slice(0, 200), task.id);
    audit(user.id, user.username, 'task_update', `#${task.id}`);
    const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow;
    res.json({ task: toTaskDto(fresh, ownerName(fresh.user_id)) });
  }),
);

api.patch(
  '/tasks/:id/speakers',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));

    const input = (req.body?.names ?? req.body) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw badRequest('请提供说话人名字映射');
    }

    // 只保留该任务真实存在的说话人标签，名字长度也做限制
    const existing = new Set<string>();
    for (const seg of safeParseSegments(task.result_json)) {
      if (seg.speaker) existing.add(seg.speaker);
    }

    const names: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
      const key = String(rawKey);
      if (!existing.has(key)) continue;
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (value) names[key] = value.slice(0, 40);
    }

    getDb()
      .prepare('UPDATE tasks SET speaker_names = ? WHERE id = ?')
      .run(JSON.stringify(names), task.id);
    audit(user.id, user.username, 'task_rename_speakers', `#${task.id}: ${JSON.stringify(names)}`);

    const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow;
    res.json({ task: toTaskDetailDto(fresh, ownerName(fresh.user_id)) });
  }),
);

api.post(
  '/tasks/:id/reprocess',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (task.status !== 'completed') throw badRequest('只有已完成的任务可以重新应用修正');

    const settings = getSettings();
    const opts = {
      enabled: settings.normalizeEnabled,
      toSimplified: settings.normalizeToSimplified,
      terms: parseTermsText(settings.normalizeTerms),
    };
    if (!opts.enabled) throw badRequest('结果修正已在设置中关闭');

    // 规范化是幂等的（缩写合并、繁转简、术语替换都不会二次生效），
    // 所以可以对已有结果直接再跑一遍，省去重新转写的等待。
    const segments = normalizeSegments(safeParseSegments(task.result_json), opts);
    const text = task.result_text ? normalizeText(task.result_text, opts) : '';

    getDb()
      .prepare('UPDATE tasks SET result_text = ?, result_json = ?, segment_count = ? WHERE id = ?')
      .run(text, JSON.stringify(segments), segments.length, task.id);
    audit(user.id, user.username, 'task_reprocess', `#${task.id}`);

    const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow;
    res.json({ task: toTaskDto(fresh, ownerName(fresh.user_id)) });
  }),
);

api.post(
  '/tasks/:id/retry',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (task.status === 'processing' || task.status === 'queued') {
      throw badRequest('任务正在处理中，无需重试');
    }
    if (!fileExists(task.storage_path)) throw badRequest('音频文件已被删除，无法重试');
    getDb()
      .prepare(
        `UPDATE tasks SET status = 'queued', stage = '排队中', progress = 3, error_message = NULL,
                          started_at = NULL, finished_at = NULL, elapsed_ms = NULL,
                          retry_count = retry_count + 1
          WHERE id = ?`,
      )
      .run(task.id);
    audit(user.id, user.username, 'task_retry', `#${task.id}`);
    enqueue();
    const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow;
    res.json({ task: toTaskDto(fresh, ownerName(fresh.user_id)) });
  }),
);

api.post(
  '/tasks/:id/cancel',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (task.status !== 'queued' && task.status !== 'processing') {
      throw badRequest('该任务不在排队或处理中');
    }
    cancelTask(task.id);
    getDb()
      .prepare(
        `UPDATE tasks SET status = 'canceled', stage = '已取消', error_message = '任务已取消',
                          finished_at = ?, progress = 0
          WHERE id = ? AND status IN ('queued', 'processing')`,
      )
      .run(nowIso(), task.id);
    audit(user.id, user.username, 'task_cancel', `#${task.id}`);
    const fresh = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as TaskRow;
    res.json({ task: toTaskDto(fresh, ownerName(fresh.user_id)) });
  }),
);

api.delete(
  '/tasks/:id',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (isRunning(task.id)) cancelTask(task.id);
    if (boolish(req.query.deleteFile, true)) deleteFileSafe(task.storage_path);
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    audit(user.id, user.username, 'task_delete', `#${task.id} ${task.title}`);
    res.json({ ok: true });
  }),
);

api.get(
  '/tasks/:id/audio',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (!fileExists(task.storage_path)) throw notFound('音频文件不存在或已被清理');
    const full = assertInsideUploads(task.storage_path!);
    const total = fileSizeSafe(full);
    res.setHeader('Content-Type', task.mime_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(task.original_name || 'audio')}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    // 支持 Range，播放器才能拖动进度条和边下边播。
    const range = req.headers.range;
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      let start: number;
      let end: number;
      if (startRaw === '' && endRaw !== '') {
        // 后缀范围：最后 N 字节
        const suffix = Number.parseInt(endRaw, 10);
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Number.parseInt(startRaw, 10);
        end = endRaw === '' ? total - 1 : Number.parseInt(endRaw, 10);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        return res.end();
      }
      end = Math.min(end, total - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(total));
    fs.createReadStream(full).pipe(res);
  }),
);

api.get(
  '/tasks/:id/download',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (!fileExists(task.storage_path)) throw notFound('音频文件不存在或已被清理');
    res.download(assertInsideUploads(task.storage_path!), task.original_name || `task-${task.id}`);
  }),
);

function buildExport(task: TaskRow, format: string): { body: string; filename: string; type: string } {
  const segments = safeParseSegments(task.result_json);
  const names = safeParseSpeakerNames(task.speaker_names);
  // 导出里优先用用户起的名字，没有再退回 SPEAKER_xx
  const label = (spk: string | null | undefined): string =>
    spk ? names[spk] || spk : '';
  const base = (task.title || `task-${task.id}`).replace(/[\\/:*?"<>|]/g, '_');
  const pad2 = (n: number): string => String(Math.floor(n)).padStart(2, '0');
  const stamp = (sec: number, sep: '.' | ','): string => {
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${pad2(sec / 3600)}:${pad2((sec % 3600) / 60)}:${pad2(sec % 60)}${sep}${String(ms).padStart(3, '0')}`;
  };
  const withSpeaker = (speaker: string | null | undefined, text: string): string =>
    task.diarize === 1 && speaker ? `[${label(speaker)}] ${text}` : text;

  switch (format) {
    case 'srt':
      return {
        body: segments
          .map(
            (s, i) =>
              `${i + 1}\n${stamp(s.start, ',')} --> ${stamp(s.end, ',')}\n${withSpeaker(s.speaker, s.text)}\n`,
          )
          .join('\n'),
        filename: `${base}.srt`,
        type: 'text/plain; charset=utf-8',
      };
    case 'vtt':
      return {
        body:
          'WEBVTT\n\n' +
          segments
            .map((s) => `${stamp(s.start, '.')} --> ${stamp(s.end, '.')}\n${withSpeaker(s.speaker, s.text)}\n`)
            .join('\n'),
        filename: `${base}.vtt`,
        type: 'text/vtt; charset=utf-8',
      };
    case 'json':
      return {
        body: JSON.stringify(
          {
            task: {
              id: task.id,
              title: task.title,
              originalName: task.original_name,
              language: task.detected_lang || task.language,
              diarize: task.diarize === 1,
              speakerCount: task.speaker_count,
              duration: task.duration,
              createdAt: task.created_at,
            },
            speakerNames: names,
            text: task.result_text,
            segments,
            speakerLines: buildSpeakerLines(segments).map((l) => ({
              ...l,
              speakerName: label(l.speaker),
            })),
          },
          null,
          2,
        ),
        filename: `${base}.json`,
        type: 'application/json; charset=utf-8',
      };
    case 'txt':
    default: {
      const lines = buildSpeakerLines(segments);
      const body =
        task.diarize === 1 && lines.some((l) => l.speaker && l.speaker !== 'SPEAKER_?')
          ? lines.map((l) => `[${label(l.speaker)}] ${l.text}`).join('\n\n')
          : task.result_text || segments.map((s) => s.text).join('\n');
      return { body, filename: `${base}.txt`, type: 'text/plain; charset=utf-8' };
    }
  }
}

api.get(
  '/tasks/:id/export',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (task.status !== 'completed') throw badRequest('任务尚未完成，暂无结果可导出');
    const format = str(req.query.format) || 'txt';
    if (!['txt', 'srt', 'vtt', 'json'].includes(format)) throw badRequest('不支持的导出格式');
    const { body, filename, type } = buildExport(task, format);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(body);
  }),
);

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

api.get(
  '/storage',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const scope = scopeOf(user, 't');
    const db = getDb();
    const whereSql = scope.sql ? `WHERE ${scope.sql}` : '';
    const rows = db
      .prepare(`SELECT t.* FROM tasks t ${whereSql} ORDER BY t.created_at DESC, t.id DESC LIMIT 500`)
      .all(...scope.params) as TaskRow[];
    const totalBytes = (
      db.prepare(`SELECT COALESCE(SUM(t.file_size),0) AS b FROM tasks t ${whereSql}`).get(...scope.params) as {
        b: number;
      }
    ).b;

    const orphans = findOrphans(storageRoot(user));
    const disk = diskUsage();
    const settings = getSettings();
    res.json({
      items: rows.filter((r) => !!r.storage_path).map(toStorageItem),
      summary: {
        totalBytes,
        fileCount: rows.filter((r) => !!r.storage_path).length,
        taskCount: rows.length,
        orphanBytes: orphans.reduce((a, o) => a + o.size, 0),
        orphanCount: orphans.length,
        diskFreeBytes: disk.freeBytes,
        diskTotalBytes: disk.totalBytes,
        quotaMb: settings.storageQuotaMb,
        uploadDir: storageRoot(user),
        databasePath: DATABASE_FILE,
      },
    });
  }),
);

api.delete(
  '/storage/orphans',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const orphans = findOrphans(storageRoot(user));
    let removed = 0;
    let freed = 0;
    for (const orphan of orphans) {
      freed += orphan.size;
      if (deleteFileSafe(orphan.path)) removed += 1;
    }
    audit(user.id, user.username, 'storage_cleanup', `removed=${removed} freed=${freed}`);
    res.json({ removed, freed });
  }),
);

api.delete(
  '/storage/tasks/:id',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const task = loadTaskFor(req, toInt(req.params.id, 0));
    if (isRunning(task.id)) throw badRequest('任务正在处理中，请先取消');
    const freed = fileSizeSafe(task.storage_path);
    const removed = deleteFileSafe(task.storage_path);
    getDb().prepare('UPDATE tasks SET storage_path = NULL, file_size = 0 WHERE id = ?').run(task.id);
    audit(user.id, user.username, 'storage_delete_file', `#${task.id} ${task.original_name}`);
    res.json({ ok: true, removed, freed });
  }),
);

api.post(
  '/storage/cleanup',
  requireAdmin,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const days = clamp(toInt(req.body?.retainDays ?? getSettings().storageRetainDays, 0), 0, 3650);
    if (days <= 0) throw badRequest('请设置保留天数（需大于 0）');
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM tasks
          WHERE storage_path IS NOT NULL AND created_at < ? AND status NOT IN ('queued','processing')
          LIMIT 2000`,
      )
      .all(cutoff) as TaskRow[];
    let freed = 0;
    for (const row of rows) {
      freed += fileSizeSafe(row.storage_path);
      deleteFileSafe(row.storage_path);
      db.prepare('UPDATE tasks SET storage_path = NULL, file_size = 0 WHERE id = ?').run(row.id);
    }
    audit(user.id, user.username, 'storage_cleanup_retention', `days=${days} removed=${rows.length}`);
    res.json({ removed: rows.length, freed, retainDays: days });
  }),
);

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

api.get(
  '/dashboard',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = requireUser(req);
    const scope = scopeOf(user, 't');
    const whereSql = scope.sql ? `WHERE ${scope.sql}` : '';
    const db = getDb();
    const counts = db
      .prepare(`SELECT t.status AS s, COUNT(*) AS c FROM tasks t ${whereSql} GROUP BY t.status`)
      .all(...scope.params) as { s: string; c: number }[];
    const stats: Record<string, number> = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
    };
    for (const c of counts) stats[c.s] = c.c;
    const agg = db
      .prepare(
        `SELECT COALESCE(SUM(t.file_size),0) AS bytes,
                COALESCE(SUM(t.duration),0)  AS secs,
                COUNT(*) AS total
           FROM tasks t ${whereSql}`,
      )
      .get(...scope.params) as { bytes: number; secs: number; total: number };
    const recent = db
      .prepare(`SELECT t.* FROM tasks t ${whereSql} ORDER BY t.created_at DESC, t.id DESC LIMIT 8`)
      .all(...scope.params) as TaskRow[];
    const isAdminUser = user.role === 'admin' || user.role === 'superadmin';
    const userCount = isAdminUser
      ? (db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get() as { c: number }).c
      : 0;

    res.json({
      stats,
      total: agg.total,
      totalBytes: agg.bytes,
      totalSeconds: agg.secs,
      userCount,
      recent: recent.map((r) => toTaskDto(r, ownerName(r.user_id))),
    });
  }),
);
