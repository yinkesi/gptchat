import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * 配对授权（agentToken 明文）仅在西次场景需要落库：批准后、bridge 首次领取前。
 * 用 AES-256-GCM 加密存储，密钥由 JWT_SECRET 派生 —— 数据库文件泄漏不直接泄漏令牌。
 * 领取完成后立即清空密文。
 */
function key(): Buffer {
  return createHash('sha256').update(`${config.jwtSecret}::gptchat-grants-v1`).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

export function decryptJson<T>(blob: string): T | null {
  try {
    const [ivB64, tagB64, dataB64] = blob.split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const data = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]);
    return JSON.parse(data.toString('utf8')) as T;
  } catch {
    return null;
  }
}
