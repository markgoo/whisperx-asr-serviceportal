import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message, 'bad_request');
}

export function unauthorized(message = '未登录'): HttpError {
  return new HttpError(401, message, 'unauthorized');
}

export function forbidden(message = '没有权限'): HttpError {
  return new HttpError(403, message, 'forbidden');
}

export function notFound(message = '不存在'): HttpError {
  return new HttpError(404, message, 'not_found');
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message, 'conflict');
}

/** Wrap an async route handler so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function boolish(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

export function optionalInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
