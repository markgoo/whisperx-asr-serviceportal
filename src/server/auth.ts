import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getDb } from './db';
import { nowIso, unauthorized, forbidden } from './util';
import type { PublicUser, Role, UserRow } from './types';

export const SESSION_COOKIE = 'portal_sid';

export interface AuthedRequest extends Request {
  user?: UserRow;
  sessionToken?: string;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function createSession(
  userId: number,
  days: number,
  userAgent: string,
  ip: string,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  getDb()
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, sha256(token), now.toISOString(), expires.toISOString(), userAgent.slice(0, 400), ip.slice(0, 100));
  return { token, expiresAt: expires.toISOString() };
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(userId: number, exceptToken?: string): void {
  const db = getDb();
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(
      userId,
      sha256(exceptToken),
    );
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function purgeExpiredSessions(): void {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const chunk of header.split(';')) {
    const idx = chunk.indexOf('=');
    if (idx < 0) continue;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/** Resolves the session cookie into req.user, if the session is still valid. */
export function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return next();
  const row = getDb()
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as (UserRow & { token_hash: string; expires_at: string }) | undefined;
  if (!row) return next();
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return next();
  }
  if (row.status !== 'active') return next();
  const { token_hash: _th, expires_at: _exp, ...user } = row;
  req.user = user as UserRow;
  req.sessionToken = token;
  next();
}

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('需要管理员权限'));
    next();
  };
}

export const requireAdmin = requireRole('admin', 'superadmin');
export const requireSuperadmin = requireRole('superadmin');

export function isAdmin(user: UserRow | undefined): boolean {
  return !!user && (user.role === 'admin' || user.role === 'superadmin');
}

export function toPublicUser(row: UserRow, extra?: Partial<PublicUser>): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    ...extra,
  };
}

export function cookieOptions(maxAgeMs: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}
