import { Router } from 'express';
import {
  CreateRoomInput,
  DEFAULT_MAX_AGENT_CHAIN,
  MAX_AGENTS_PER_ROOM,
  MAX_ROOMS_PER_USER,
  SendMessageInput,
  UpdateRoomInput,
  type PublicMessage,
} from '@gptchat/shared';
import { getDb, audit } from '../db.js';
import { newId } from '../crypto.js';
import { badRequest, forbidden, notFound, tooMany, unauthorized } from '../errors.js';
import { dbOf, requireUser, type AgentRow, type UserRow } from '../middleware/auth.js';
import { pagination, validated, messageLimiter, z, param } from '../middleware/common.js';
import {
  toPublicAgent,
  toPublicMessage,
  toPublicRoom,
  toPublicUser,
  parseSettings,
  type RoomRow,
} from '../core/mappers.js';
import { postMessage, loadProposalPayload, type ChatContext } from '../core/chat.js';

export function roomsRouter(ctx: ChatContext): Router {
  const router = Router();
  void ctx;

  // ---------- 房间 CRUD ----------

  router.post('/rooms', requireUser, async (req, res) => {
    const input = validated(req, CreateRoomInput);
    const db = dbOf(req);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const count = db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE owner_id = ?').get(p.userId) as { n: number };
    if (count.n >= MAX_ROOMS_PER_USER) throw badRequest(`每个用户最多创建 ${MAX_ROOMS_PER_USER} 个房间`);

    const id = newId('room');
    const now = Date.now();
    const settings = {
      agentAutoReply: true,
      maxAgentChain: DEFAULT_MAX_AGENT_CHAIN,
      consensusRatio: 0.5,
    };
    db.prepare('INSERT INTO rooms (id, name, topic, owner_id, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      input.name,
      input.topic,
      p.userId,
      JSON.stringify(settings),
      now,
    );
    db.prepare('INSERT INTO room_members (room_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      p.userId,
      'owner',
      now,
    );

    // 可选：直接拉入自己拥有的智能体
    for (const agentId of input.agentIds ?? []) {
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as unknown as AgentRow | undefined;
      if (agent && agent.owner_id === p.userId) {
        db.prepare('INSERT OR IGNORE INTO agent_rooms (agent_id, room_id, created_at) VALUES (?, ?, ?)').run(
          agent.id,
          id,
          now,
        );
      }
    }

    // 可选：零配置演示智能体（内置回声）
    if (input.withDemoAgent === true) {
      let demo = db
        .prepare("SELECT * FROM agents WHERE owner_id = ? AND kind = 'builtin' AND adapter = 'echo'")
        .get(p.userId) as unknown as AgentRow | undefined;
      if (!demo) {
        const demoId = newId('agent');
        db.prepare(
          `INSERT INTO agents (id, owner_id, name, kind, adapter, description, created_at) VALUES (?, ?, ?, 'builtin', 'echo', ?, ?)`,
        ).run(demoId, p.userId, 'Echo', '内置演示回声智能体', now);
        demo = db.prepare('SELECT * FROM agents WHERE id = ?').get(demoId) as unknown as AgentRow;
      }
      db.prepare('INSERT OR IGNORE INTO agent_rooms (agent_id, room_id, created_at) VALUES (?, ?, ?)').run(
        demo.id,
        id,
        now,
      );
    }

    audit(db, 'user', p.userId, 'room.create', { room: id }, req.ip);
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as unknown as RoomRow;
    res.status(201).json({ room: toPublicRoom(room) });
  });

  router.get('/rooms', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const rows = dbOf(req)
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS member_count,
           (SELECT COUNT(*) FROM agent_rooms ar WHERE ar.room_id = r.id) AS agent_count
         FROM rooms r JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = ?
         ORDER BY r.created_at DESC`,
      )
      .all(p.userId) as unknown as Array<RoomRow & { member_count: number; agent_count: number }>;
    res.json({
      rooms: rows.map((r) => ({ ...toPublicRoom(r), memberCount: r.member_count, agentCount: r.agent_count })),
    });
  });

  function requireRoomMember(db: ReturnType<typeof getDb>, roomId: string, userId: string): { room: RoomRow; role: string } {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as unknown as RoomRow | undefined;
    if (!room) throw notFound('房间不存在');
    const member = db
      .prepare('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as { role: string } | undefined;
    if (!member) throw forbidden('不是该房间成员');
    return { room, role: member.role };
  }

  router.get('/rooms/:id', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const { room, role } = requireRoomMember(db, param(req, 'id'), p.userId);
    const members = db
      .prepare(
        `SELECT u.* FROM users u JOIN room_members m ON m.user_id = u.id WHERE m.room_id = ?`,
      )
      .all(room.id) as unknown as UserRow[];
    const agents = db
      .prepare(
        `SELECT a.* FROM agents a JOIN agent_rooms ar ON ar.agent_id = a.id WHERE ar.room_id = ? ORDER BY a.name`,
      )
      .all(room.id) as unknown as AgentRow[];
    res.json({
      room: toPublicRoom(room),
      role,
      members: members.map(toPublicUser),
      agents: agents.map(toPublicAgent),
    });
  });

  router.patch('/rooms/:id', requireUser, async (req, res) => {
    const input = validated(req, UpdateRoomInput);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const { room } = requireRoomMember(db, param(req, 'id'), p.userId);
    if (room.owner_id !== p.userId) throw forbidden('只有房主可以修改房间');

    if (input.topic !== undefined) {
      db.prepare('UPDATE rooms SET topic = ? WHERE id = ?').run(input.topic, room.id);
    }
    if (input.settings) {
      const merged = { ...parseSettings(room.settings), ...input.settings };
      db.prepare('UPDATE rooms SET settings = ? WHERE id = ?').run(JSON.stringify(merged), room.id);
    }
    const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id) as unknown as RoomRow;
    res.json({ room: toPublicRoom(updated) });
  });

  router.delete('/rooms/:id', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const { room } = requireRoomMember(db, param(req, 'id'), p.userId);
    if (room.owner_id !== p.userId) throw forbidden('只有房主可以删除房间');
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
    audit(db, 'user', p.userId, 'room.delete', { room: room.id }, req.ip);
    res.json({ ok: true });
  });

  // ---------- 成员 ----------

  router.post('/rooms/:id/members', requireUser, async (req, res) => {
    const body = z.object({ username: z.string().min(1).max(32) }).parse(req.body);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const { room, role } = requireRoomMember(db, param(req, 'id'), p.userId);
    if (role !== 'owner') throw forbidden('只有房主可以邀请成员');
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND disabled = 0').get(body.username) as unknown as UserRow | undefined;
    if (!target) throw notFound('用户不存在');
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(
      room.id,
      target.id,
      'member',
      Date.now(),
    );
    audit(db, 'user', p.userId, 'room.member.add', { room: room.id, member: target.id }, req.ip);
    res.status(201).json({ user: toPublicUser(target) });
  });

  router.delete('/rooms/:id/members/:userId', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const { room, role } = requireRoomMember(db, param(req, 'id'), p.userId);
    const targetId = param(req, 'userId');
    if (role !== 'owner' && targetId !== p.userId) throw forbidden('只能移除自己或由房主操作');
    if (targetId === room.owner_id) throw badRequest('不能移除房主');
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(room.id, targetId);
    res.json({ ok: true });
  });

  // ---------- 智能体加入/退出 ----------

  router.post('/rooms/:id/agents', requireUser, async (req, res) => {
    const body = z.object({ agentId: z.string().min(1).max(64) }).parse(req.body);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    // 房间成员即可把自己拥有的智能体拉进群（协作分工场景：各带各的智能体）
    requireRoomMember(db, param(req, 'id'), p.userId);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(body.agentId) as unknown as AgentRow | undefined;
    if (!agent) throw notFound('智能体不存在');
    if (agent.owner_id !== p.userId) throw forbidden('只能添加自己拥有的智能体');
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM agent_rooms WHERE room_id = ?').get(param(req, 'id')) as { n: number };
    if (cnt.n >= MAX_AGENTS_PER_ROOM) throw badRequest(`房间最多接入 ${MAX_AGENTS_PER_ROOM} 个智能体`);
    db.prepare('INSERT OR IGNORE INTO agent_rooms (agent_id, room_id, created_at) VALUES (?, ?, ?)').run(
      agent.id,
      param(req, 'id'),
      Date.now(),
    );
    audit(db, 'user', p.userId, 'room.agent.add', { room: param(req, 'id'), agent: agent.id }, req.ip);
    if (agent.status === 'online') {
      ctx.presence.online(agent.id); // 广播 presence 给房间
    }
    res.status(201).json({ agent: toPublicAgent(agent) });
  });

  router.delete('/rooms/:id/agents/:agentId', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const { room } = requireRoomMember(db, param(req, 'id'), p.userId);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(param(req, 'agentId')) as unknown as AgentRow | undefined;
    if (!agent) throw notFound('智能体不存在');
    if (room.owner_id !== p.userId && agent.owner_id !== p.userId) throw forbidden();
    db.prepare('DELETE FROM agent_rooms WHERE room_id = ? AND agent_id = ?').run(room.id, agent.id);
    ctx.presence.offline(agent.id);
    res.json({ ok: true });
  });

  // ---------- 消息 ----------

  router.get('/rooms/:id/messages', (req, res) => {
    const db = dbOf(req);
    const p = req.principal;
    const roomId = param(req, 'id');
    let allowed = false;
    if (p?.kind === 'user') {
      allowed = !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, p.userId);
    } else if (p?.kind === 'agent') {
      allowed = !!db.prepare('SELECT 1 FROM agent_rooms WHERE room_id = ? AND agent_id = ?').get(roomId, p.agentId);
    } else if (p?.kind === 'device') {
      allowed = p.agentIds.some((aid) =>
        db.prepare('SELECT 1 FROM agent_rooms WHERE room_id = ? AND agent_id = ?').get(roomId, aid),
      );
    }
    if (!allowed) throw forbidden('不是该房间成员');

    const { before, limit } = pagination(req);
    const rows = (
      before
        ? db.prepare('SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(roomId, before, limit)
        : db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?').all(roomId, limit)
    ) as unknown as import('../core/mappers.js').MessageRow[];
    const messages: PublicMessage[] = rows
      .map((r) => toPublicMessage(r, r.proposal_id ? loadProposalPayload(db, r.proposal_id) : null))
      .reverse();
    res.json({ messages, hasMore: rows.length === limit });
  });

  router.post('/rooms/:id/messages', messageLimiter(), async (req, res) => {
    const input = validated(req, SendMessageInput);
    const db = dbOf(req);
    const p = req.principal;
    const roomId = param(req, 'id');

    if (p?.kind === 'user') {
      requireRoomMember(db, roomId, p.userId);
      const message = postMessage(ctx, {
        roomId,
        senderType: 'user',
        senderId: p.userId,
        senderName: p.user.display_name,
        body: input.body,
        proposal: input.proposal,
        taskUpdate: input.taskUpdate,
        ip: req.ip,
      });
      res.status(201).json({ message });
      return;
    }

    if (p?.kind === 'agent') {
      const member = db.prepare('SELECT 1 FROM agent_rooms WHERE room_id = ? AND agent_id = ?').get(roomId, p.agentId);
      if (!member) throw forbidden('智能体不在该房间');
      const remain = ctx.flow.agentCooldownRemaining(roomId, p.agentId);
      if (remain > 0) {
        throw tooMany(`智能体发言冷却中（${Math.ceil(remain / 100) / 10}s）`, {
          'Retry-After': String(Math.ceil(remain / 1000)),
        });
      }
      const message = postMessage(ctx, {
        roomId,
        senderType: 'agent',
        senderId: p.agentId,
        senderName: p.agent.name,
        body: input.body,
        proposal: input.proposal,
        taskUpdate: input.taskUpdate,
        ip: req.ip,
      });
      db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(Date.now(), p.agentId);
      res.status(201).json({ message });
      return;
    }

    throw unauthorized('需要用户会话或智能体令牌');
  });

  return router;
}

