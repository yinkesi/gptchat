import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb, audit, type DB } from '../db.js';
import { unauthorized } from '../errors.js';
import { hashToken } from '../crypto.js';
import { SESSION_COOKIE, SESSION_TTL_MS, DEVICE_TOKEN_TTL_MS } from '@gptchat/shared';
import type { AgentRow, DeviceRow, UserRow } from '../types.js';

export type { AgentRow, DeviceRow, UserRow } from '../types.js';

export type Principal =
  | { kind: 'user'; userId: string; user: UserRow }
  | { kind: 'agent'; agentId: string; agent: AgentRow }
  | { kind: 'device'; deviceId: string; ownerId: string; device: DeviceRow; agentIds: string[] };

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
      db?: DB;
    }
  }
}

export function dbOf(req: Request): DB {
  return req.db ?? getDb();
}

// ---------- JWT 签发/校验 ----------

export function signSessionJwt(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'session' }, config.jwtSecret, {
    expiresIn: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function signDeviceJwt(deviceId: string): string {
  return jwt.sign({ sub: deviceId, typ: 'device' }, config.jwtSecret, {
    expiresIn: Math.floor(DEVICE_TOKEN_TTL_MS / 1000),
  });
}

export function verifyJwt(token: string): { sub: string; typ: string } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string') return null;
    if (typeof payload.sub !== 'string' || typeof payload.typ !== 'string') return null;
    return { sub: payload.sub, typ: payload.typ };
  } catch {
    return null;
  }
}

// ---------- 行读取 ----------

export function userById(d: DB, id: string): UserRow | undefined {
  return d.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id) as unknown as UserRow | undefined;
}

export function agentById(d: DB, id: string): AgentRow | undefined {
  return d.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow | undefined;
}

export function deviceById(d: DB, id: string): DeviceRow | undefined {
  return d.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
}

/** 设备是否仍可用（未被吊销）。token_hash 仅作为吊销标记位。 */
export function deviceUsable(device: DeviceRow): boolean {
  return device.status === 'approved';
}

// ---------- 主体解析 ----------

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function cookieSession(req: Request): string | null {
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

function principalFromAgentToken(d: DB, token: string): Principal | null {
  const agent = d
    .prepare('SELECT * FROM agents WHERE token_hash = ?')
    .get(hashToken(token)) as unknown as AgentRow | undefined;
  if (!agent) return null;
  if (agent.device_id) {
    const dev = deviceById(d, agent.device_id);
    if (!dev || !deviceUsable(dev)) return null;
  }
  return { kind: 'agent', agentId: agent.id, agent };
}

function principalFromJwt(d: DB, token: string): Principal | null {
  const payload = verifyJwt(token);
  if (!payload) return null;
  if (payload.typ === 'session') {
    const user = userById(d, payload.sub);
    return user ? { kind: 'user', userId: user.id, user } : null;
  }
  if (payload.typ === 'device') {
    const dev = deviceById(d, payload.sub);
    if (dev && deviceUsable(dev)) {
      const agentIds = (
        d.prepare('SELECT id FROM agents WHERE device_id = ?').all(dev.id) as Array<{ id: string }>
      ).map((r) => r.id);
      return { kind: 'device', deviceId: dev.id, ownerId: dev.owner_id ?? '', device: dev, agentIds };
    }
  }
  return null;
}

function resolvePrincipal(req: Request): Principal | null {
  const d = dbOf(req);
  const bearerToken = bearer(req);
  const sessionToken = cookieSession(req);

  // 智能体令牌（非 JWT，散列查库）
  if (bearerToken?.startsWith('gptc_')) {
    return principalFromAgentToken(d, bearerToken);
  }
  // Bearer 优先于 Cookie 会话
  for (const token of [bearerToken, sessionToken]) {
    if (!token) continue;
    const principal = principalFromJwt(d, token);
    if (principal) return principal;
  }
  return null;
}

/** 解析主体；匿名放行（路由自行决定是否要求登录）。 */
export function attachPrincipal(req: Request, _res: Response, next: NextFunction): void {
  try {
    req.principal = resolvePrincipal(req) ?? undefined;
    next();
  } catch {
    next();
  }
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (req.principal?.kind !== 'user') return next(unauthorized());
  next();
}

export function requireAgent(req: Request, _res: Response, next: NextFunction): void {
  if (req.principal?.kind !== 'agent') return next(unauthorized('需要智能体令牌'));
  next();
}

/** 审计辅助：以请求主体身份记一条审计。 */
export function auditReq(req: Request, event: string, meta: Record<string, unknown> = {}): void {
  const p = req.principal;
  const actorType = p?.kind ?? 'anonymous';
  const actorId =
    p?.kind === 'user' ? p.userId : p?.kind === 'agent' ? p.agentId : p?.kind === 'device' ? p.deviceId : null;
  audit(dbOf(req), actorType, actorId, event, meta, req.ip);
}
