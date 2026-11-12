import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOAD_DIR } from './config';
import { formatBytes } from './util';

/** Directory layout: data/uploads/<userId>/<uuid><ext> */
export function userUploadDir(userId: number): string {
  const dir = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newFileId(): string {
  return randomUUID();
}

export function storagePathFor(userId: number, fileId: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().slice(0, 12) || '.bin';
  return path.join(userUploadDir(userId), `${fileId}${ext}`);
}

/** Resolve a stored path, refusing anything that escaped the uploads root. */
export function assertInsideUploads(p: string): string {
  const resolved = path.resolve(p);
  const root = path.resolve(UPLOAD_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('非法文件路径');
  }
  return resolved;
}

export function fileSizeSafe(p: string | null): number {
  if (!p) return 0;
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function fileExists(p: string | null): boolean {
  if (!p) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function deleteFileSafe(p: string | null): boolean {
  if (!p) return false;
  try {
    fs.unlinkSync(assertInsideUploads(p));
    return true;
  } catch {
    return false;
  }
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export function diskUsage(): DiskUsage {
  try {
    const s = fs.statfsSync(UPLOAD_DIR);
    return {
      totalBytes: Number(s.bsize) * Number(s.blocks),
      freeBytes: Number(s.bsize) * Number(s.bavail),
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

/** Human readable, used in log lines. */
export function describeSize(bytes: number): string {
  return formatBytes(bytes);
}

/** Recursively total the bytes under the uploads root. */
export function directorySize(root: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}
