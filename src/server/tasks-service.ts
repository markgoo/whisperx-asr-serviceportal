import type { AuthedRequest } from './auth';
import { getDb } from './db';
import { HttpError, nowIso, unauthorized } from './util';
import type { Role, TaskRow } from './types';

/** Admins see every task; ordinary users only their own. */
export function canAccessTask(req: AuthedRequest, task: TaskRow): boolean {
  const user = req.user;
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'superadmin') return true;
  return task.user_id === user.id;
}

export function loadTaskOr404(taskId: number): TaskRow {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
  if (!row) throw new HttpError(404, '任务不存在', 'not_found');
  return row;
}

export function loadTaskFor(req: AuthedRequest, taskId: number): TaskRow {
  const task = loadTaskOr404(taskId);
  if (!canAccessTask(req, task)) throw new HttpError(404, '任务不存在', 'not_found');
  return task;
}

export function requireUser(req: AuthedRequest) {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function roleLabel(role: Role): string {
  switch (role) {
    case 'superadmin':
      return '超级管理员';
    case 'admin':
      return '管理员';
    default:
      return '普通用户';
  }
}

export function touchTask(
  taskId: number,
  patch: Partial<
    Pick<
      TaskRow,
      | 'status'
      | 'stage'
      | 'progress'
      | 'error_message'
      | 'started_at'
      | 'finished_at'
      | 'elapsed_ms'
      | 'result_text'
      | 'result_json'
      | 'segment_count'
      | 'speaker_count'
      | 'detected_lang'
      | 'duration'
    >
  >,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
  getDb()
    .prepare(`UPDATE tasks SET ${assignments} WHERE id = ?`)
    .run(...values, taskId);
}

export function isoNow(): string {
  return nowIso();
}
