import {
  randomBytes,
  createHash,
  timingSafeEqual,
  scrypt as scryptCb,
  type ScryptOptions,
} from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) =>
      err ? reject(err) : resolve(derivedKey),
    );
  });

// ---------- 随机标识 ----------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 短 ID：前缀 + 96bit 随机（URL 安全）。 */
export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

/** 高熵 URL 安全令牌（用于配对请求 ID 等匿名凭据）。 */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 智能体令牌：带前缀便于识别与扫描泄漏。 */
export function newAgentToken(): string {
  return `gptc_${randomBytes(32).toString('base64url')}`;
}

/** 6 位配对码（去掉易混淆字符）。 */
export function newPairCode(): string {
  const set = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += set[bytes[i]! % set.length];
  return out;
}

// ---------- 令牌散列（数据库只存散列） ----------

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------- 密码散列（scrypt，OWASP 推荐参数） ----------

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}
