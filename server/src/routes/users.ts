import { Router } from 'express';
import { dbOf, requireUser, type UserRow } from '../middleware/auth.js';
import { toPublicUser } from '../core/mappers.js';

export const usersRouter = Router();

/** 用户搜索（邀请成员用）：前缀匹配，严格限长，仅返回公开字段。 */
usersRouter.get('/users', requireUser, (req, res) => {
  const raw = (req.query as { q?: string | string[] }).q;
  const q = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  if (q.length < 1) return void res.json({ users: [] });
  const safe = q.slice(0, 32);
  const rows = dbOf(req)
    .prepare(
      `SELECT * FROM users WHERE disabled = 0 AND (username LIKE ? COLLATE NOCASE OR display_name LIKE ? COLLATE NOCASE) LIMIT 10`,
    )
    .all(`${safe}%`, `${safe}%`) as unknown as UserRow[];
  res.json({ users: rows.map(toPublicUser) });
});
