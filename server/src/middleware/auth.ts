import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb, audit, type DB } from '../db.js';
import { unauthorized, forbidden } from '../errors.js';
import { hashToken } from '../crypto.js';
import { SESSION_COOKIE, SESSION_TTL_MS, DEVICE_TOKEN_TTL_MS } from '@gptchat/shared';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
  disabled: number;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  device_id: string | null;
  name: string;
  kind: string;
  adapter: string;
  model: string | null;
  description: string;
  token_hash: string | null;
  status: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface DeviceRow {
  id: string;
  owner_id: string | null;
  machine_name: string;
  platform: string;
  pair_code: string;
  status: string;
  token_hash: string | null;
  candidates: string;
  grants_pending: string | null;
  grants_delivered: number;
  requested_at: number;
  approved_at: number | null;
  expires_at: number;
  last_seen_at: number | null;
}

export type Principal =
  | { kind: 'user'; userId: string; user: UserRow }
  | { kind: 'agent'; agentId: string; agent: AgentRow }
  | { kind: 'device'; deviceId: string; ownerId: string; device: DeviceRow; agentIds: string[] };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
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

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function cookieSession(req: Request): string | null {
  // cookie-parser 已挂载；防御性读取
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  return cookies?.[SESSION_COOKIE] ?? null;
}

export function userById(d: DB, id: string): UserRow | undefined {
  return d.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(id) as unknown as UserRow | undefined;
}

export function agentById(d: DB, id: string): AgentRow | undefined {
  return d.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow | undefined;
}

export function deviceById(d: DB, id: string): DeviceRow | undefined {
  return d.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as DeviceRow | undefined;
}

/** 检查设备主体当前是否仍有权连接（未吊销）。 */
export function deviceUsable(d: DB, device: DeviceRow): boolean {
  return device.status === 'approved';
}

function resolvePrincipal(req: Request): Principal | null {
  const d = dbOf(req);
  const bearerToken = bearer(req);
  const sessionToken = cookieSession(req);

  // 1) 智能体令牌（非 JWT，数据库查散列）
  if (bearerToken?.startsWith('gptc_')) {
    const agent = d
      .prepare('SELECT * FROM agents WHERE token_hash = ?')
      .get(hashToken(bearerToken)) as unknown as AgentRow | undefined;
    if (!agent) return null;
    if (agent.device_id) {
      const dev = deviceById(d, agent.device_id);
      if (!dev || !deviceUsable(d, dev)) return null;
    }
    return { kind: 'agent', agentId: agent.id, agent };
  }

  // 2) Bearer JWT（会话 / 设备）
  for (const token of [bearerToken, sessionToken]) {
    if (!token) continue;
    const payload = verifyJwt(token);
    if (!payload) continue;
    if (payload.typ === 'session') {
      const user = userById(d, payload.sub);
      if (user) return { kind: 'user', userId: user.id, user };
    } else if (payload.typ === 'device') {
      const dev = deviceById(d, payload.sub);
      if (dev && deviceUsable(d, dev)) {
        const agentIds = (
          d.prepare('SELECT id FROM agents WHERE device_id = ?').all(dev.id) as Array<{ id: string }>
        ).map((r) => r.id);
        return { kind: 'device', deviceId: dev.id, ownerId: dev.owner_id ?? '', device: dev, agentIds };
      }
    }
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

/** 审计辅助 */
export function auditReq(req: Request, event: string, meta: Record<string, unknown> = {}): void {
  const p = req.principal;
  const actorType = p?.kind ?? 'anonymous';
  const actorId =
    p?.kind === 'user' ? p.userId : p?.kind === 'agent' ? p.agentId : p?.kind === 'device' ? p.deviceId : null;
  audit(dbOf(req), actorType, actorId, event, meta, req.ip);
}

export { forbidden };
