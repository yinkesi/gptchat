import { randomBytes } from 'node:crypto';
import path from 'node:path';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`缺少必需环境变量 ${name}`);
  }
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * 生产环境强制使用外部密钥；开发环境回退到固定密钥（仅本地便利）。
 */
function jwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (isProd) {
    throw new Error('生产环境必须设置 JWT_SECRET（至少 32 字符）。可用：node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  }
  return 'dev-only-insecure-secret-' + '0'.repeat(32);
}

export const config = {
  isProd,
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8780),
  jwtSecret: jwtSecret(),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8780}`,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  dbPath: path.resolve(process.env.DB_PATH ?? './data/gptchat.db'),
  trustProxy: process.env.TRUST_PROXY === '1',
  logLevel: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
} as const;

export function generateSecret(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}
