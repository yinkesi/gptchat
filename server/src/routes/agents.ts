import { Router } from 'express';
import {
  CreateAgentInput,
  MAX_AGENTS_PER_USER,
} from '@gptchat/shared';
import { getDb, audit } from '../db.js';
import { hashToken, newAgentToken, newId } from '../crypto.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { dbOf, requireAgent, requireUser, type AgentRow } from '../middleware/auth.js';
import { validated, z, param } from '../middleware/common.js';
import { toPublicAgent, toPublicRoom, type RoomRow } from '../core/mappers.js';
import { loadProposalPayload, type ChatContext } from '../core/chat.js';

const BUILTIN_ADAPTERS = new Set(['echo']);

export function agentsRouter(ctx: ChatContext): Router {
  const router = Router();

  // ---------- 用户管理自己的智能体 ----------

  router.get('/my/agents', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const rows = dbOf(req)
      .prepare('SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC')
      .all(p.userId) as unknown as AgentRow[];
    res.json({ agents: rows.map(toPublicAgent) });
  });

  router.post('/my/agents', requireUser, async (req, res) => {
    const input = validated(req, CreateAgentInput);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const count = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?').get(p.userId) as { n: number };
    if (count.n >= MAX_AGENTS_PER_USER) throw badRequest(`每个用户最多创建 ${MAX_AGENTS_PER_USER} 个智能体`);

    let kind = input.kind;
    if (kind === 'bridge') throw badRequest('bridge 类型智能体只能通过设备配对创建');
    if (kind === 'builtin' && !BUILTIN_ADAPTERS.has(input.adapter)) {
      throw badRequest(`内置智能体仅支持 adapter: ${[...BUILTIN_ADAPTERS].join('/')}`);
    }
    if (kind === 'builtin') kind = 'builtin';

    const id = newId('agent');
    const token = newAgentToken();
    db.prepare(
      `INSERT INTO agents (id, owner_id, name, kind, adapter, model, description, token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, p.userId, input.name, kind, input.adapter, input.model ?? null, input.description, hashToken(token), Date.now());
    audit(db, 'user', p.userId, 'agent.create', { agent: id, kind }, req.ip);

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow;
    res.status(201).json({ agent: toPublicAgent(agent), token }); // 令牌仅此一次明文返回
  });

  router.post('/my/agents/:id/rotate', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND owner_id = ?').get(param(req, 'id'), p.userId) as
      | AgentRow
      | undefined;
    if (!agent) throw notFound('智能体不存在');
    const token = newAgentToken();
    db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(hashToken(token), agent.id);
    audit(db, 'user', p.userId, 'agent.rotate', { agent: agent.id }, req.ip);
    res.json({ token });
  });

  router.delete('/my/agents/:id', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND owner_id = ?').get(param(req, 'id'), p.userId) as
      | AgentRow
      | undefined;
    if (!agent) throw notFound('智能体不存在');
    db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    audit(db, 'user', p.userId, 'agent.delete', { agent: agent.id }, req.ip);
    res.json({ ok: true });
  });

  // ---------- 智能体自身 API（Bearer gptc_ 令牌） ----------

  router.get('/agents/@me/rooms', requireAgent, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'agent') throw forbidden();
    const rows = dbOf(req)
      .prepare(
        `SELECT r.* FROM rooms r JOIN agent_rooms ar ON ar.room_id = r.id WHERE ar.agent_id = ? ORDER BY r.created_at DESC`,
      )
      .all(p.agentId) as unknown as RoomRow[];
    res.json({ rooms: rows.map(toPublicRoom) });
  });

  /** 收件箱：长轮询。返回未投递提及并标记已投递（至少一次语义；客户端按 inboxId 幂等处理）。 */
  router.get('/agents/@me/inbox', requireAgent, async (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'agent') throw forbidden();
    const db = dbOf(req);
    const waitSec = Math.min(Math.max(Number((req.query as { wait?: string }).wait ?? 0) || 0, 0), 25);
    const deadline = Date.now() + waitSec * 1000;

    type InboxRow = import('../core/mappers.js').MessageRow & { inbox_id: number };

    const fetchOne = (): InboxRow | null => {
      const row = db
        .prepare(
          `SELECT i.id AS inbox_id, m.*
           FROM inbox i
           JOIN messages m ON m.seq = i.message_seq
           WHERE i.agent_id = ? AND i.delivered = 0 AND i.held = 0
           ORDER BY i.id ASC LIMIT 1`,
        )
        .get(p.agentId) as InboxRow | undefined;
      return row ?? null;
    };

    let first = fetchOne();
    while (!first && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      first = fetchOne();
    }
    if (!first) {
      res.json({ items: [] });
      return;
    }
    // 拉取最多 20 条（同一智能体的积压一次性交付）
    const rows = db
      .prepare(
        `SELECT i.id AS inbox_id, m.*
         FROM inbox i JOIN messages m ON m.seq = i.message_seq
         WHERE i.agent_id = ? AND i.delivered = 0 AND i.held = 0
         ORDER BY i.id ASC LIMIT 20`,
      )
      .all(p.agentId) as unknown as InboxRow[];

    const ids = rows.map((r) => r.inbox_id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE inbox SET delivered = 1 WHERE id IN (${placeholders})`).run(...ids);

    const items = rows.map((r) => ({
      inboxId: r.inbox_id,
      messageId: r.seq,
      roomId: r.room_id,
      from: r.sender_name,
      body: r.body,
      proposal: r.proposal_id ? loadProposalPayload(db, r.proposal_id) : null,
    }));
    db.prepare('UPDATE agents SET last_seen_at = ?, status = ? WHERE id = ?').run(Date.now(), 'online', p.agentId);
    res.json({ items });
  });

  router.post('/agents/@me/inbox/ack', requireAgent, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'agent') throw forbidden();
    const body = z.object({ ids: z.array(z.number().int().positive()).max(200) }).parse(req.body);
    if (body.ids.length > 0) {
      const db = dbOf(req);
      const placeholders = body.ids.map(() => '?').join(',');
      db.prepare(`UPDATE inbox SET delivered = 1 WHERE id IN (${placeholders})`).run(...body.ids);
    }
    res.json({ ok: true });
  });

  return router;
}
