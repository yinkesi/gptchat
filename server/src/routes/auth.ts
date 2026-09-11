import { Router, type Response } from 'express';
import { LoginInput, RegisterInput, SESSION_COOKIE, SESSION_TTL_MS } from '@gptchat/shared';
import { getDb, audit } from '../db.js';
import { hashPassword, verifyPassword, newId } from '../crypto.js';
import { conflict, unauthorized } from '../errors.js';
import { auditReq, dbOf, requireUser, signSessionJwt } from '../middleware/auth.js';
import { authLimiter, validate, validated } from '../middleware/common.js';
import { toPublicUser } from '../core/mappers.js';
import { type UserRow } from '../middleware/auth.js';

export const authRouter = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_TTL_MS,
};

/** 仅当客户端声明为原生应用（CLI/bridge）时才在响应体发放令牌；浏览器一律走 HttpOnly Cookie。 */
function issue(res: Response, userId: string): string {
  const token = signSessionJwt(userId);
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  return token;
}

authRouter.post('/auth/register', authLimiter, validate(RegisterInput), async (req, res) => {
  const input = validated(req, RegisterInput);
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(input.username);
  if (exists) throw conflict('用户名已被占用');

  const id = newId('user');
  const hash = await hashPassword(input.password);
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.username, input.displayName ?? input.username, hash, Date.now());
  audit(db, 'user', id, 'auth.register', { username: input.username }, req.ip);

  const token = issue(res, id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;
  res.status(201).json({
    user: toPublicUser(user),
    token: req.get('x-gptchat-native') === '1' ? token : undefined,
  });
});

authRouter.post('/auth/login', authLimiter, validate(LoginInput), async (req, res) => {
  const input = validated(req, LoginInput);
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(input.username) as
    | UserRow
    | undefined;
  const ok = user ? user.disabled === 0 && (await verifyPassword(input.password, user.password_hash)) : false;
  if (!user || !ok) {
    audit(db, 'anonymous', null, 'auth.login.failed', { username: input.username }, req.ip);
    throw unauthorized('用户名或密码错误');
  }
  audit(db, 'user', user.id, 'auth.login', {}, req.ip);
  const token = issue(res, user.id);
  res.json({
    user: toPublicUser(user),
    token: req.get('x-gptchat-native') === '1' ? token : undefined,
  });
});

authRouter.post('/auth/logout', (req, res) => {
  auditReq(req, 'auth.logout');
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', requireUser, (req, res) => {
  const p = req.principal;
  if (p?.kind !== 'user') throw unauthorized();
  const user = dbOf(req).prepare('SELECT * FROM users WHERE id = ?').get(p.userId) as unknown as UserRow;
  res.json({ user: toPublicUser(user) });
});
