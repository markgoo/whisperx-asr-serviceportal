import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Returns `scrypt$N$r$p$saltHex$hashHex`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { ...SCRYPT_PARAMS });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string') return '密码格式不正确';
  if (password.length < 6) return '密码至少 6 位';
  if (password.length > 200) return '密码过长';
  return null;
}

export function validateUsername(username: string): string | null {
  if (!/^[A-Za-z0-9_.\-]{3,32}$/.test(username)) {
    return '用户名需为 3-32 位字母、数字、下划线、点或连字符';
  }
  return null;
}
