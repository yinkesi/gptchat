import type { RequestHandler, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../errors.js';

// ---------- 通用限流 ----------

const keyByIp = (req: Request): string => req.ip ?? 'unknown';

/** 全站 API 限流 */
export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: keyByIp,
  message: { error: { code: 'RATE_LIMITED', message: '请求过于频繁' } },
});

/** 登录/注册：按 IP + 用户名组合更严格 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${String((req.body as { username?: string })?.username ?? '')}`,
  message: { error: { code: 'RATE_LIMITED', message: '尝试次数过多，请 15 分钟后再试' } },
});

/** 配对创建：匿名端点，最严格 */
export const pairingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: keyByIp,
  message: { error: { code: 'RATE_LIMITED', message: '配对请求过于频繁' } },
});

/** 发消息：按主体（用户/智能体）限流，兜底防刷屏与失控循环 */
export function messageLimiter(limit = 40, windowMs = 60_000): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const p = req.principal;
    const key = p ? `${p.kind}:${p.kind === 'user' ? p.userId : p.kind === 'agent' ? p.agentId : p.deviceId}` : keyByIp(req);
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }
    bucket.count++;
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (bucket.count > limit) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: '发言太快，请稍候' } });
      return;
    }
    next();
  };
}

// ---------- 校验 ----------

/** zod 校验中间件：边界处统一拦截非法输入。 */
export function validate<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const where = first?.path?.join('.') ?? '';
      return next(badRequest(`参数无效${where ? `：${where}` : ''}`));
    }
    (req as Request & { validated: z.infer<T> }).validated = result.data;
    next();
  };
}

/**
 * 在处理器内直接解析并校验请求体（推荐用法 —— 校验与取值一体，不会漏挂中间件）。
 */
export function validated<T extends ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.join('.') ?? '';
    throw badRequest(`参数无效${where ? `：${where}` : ''}`);
  }
  return result.data;
}

/** 分页参数解析（白名单化，防御性） */
export function pagination(req: Request, maxLimit = 100): { before: number | null; limit: number } {
  const q = req.query as { before?: string; limit?: string };
  const before = Number(q.before);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), maxLimit);
  return {
    before: Number.isFinite(before) && before > 0 ? Math.floor(before) : null,
    limit,
  };
}

/** 安全读取路径参数（Express 5 类型里可能是 string | string[]）。 */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

export { z };
