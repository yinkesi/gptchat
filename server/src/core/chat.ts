import type { PublicMessage, ProposalPayload, SendMessageInput } from '@gptchat/shared';
import { PROPOSAL_TTL_MS } from '@gptchat/shared';
import type { DB } from '../db.js';
import { audit } from '../db.js';
import { newId } from '../crypto.js';
import { forbidden, notFound } from '../errors.js';
import { parseMentions } from './mentions.js';
import {
  parseSettings,
  toPublicMessage,
  toProposalPayload,
  type MessageRow,
  type ProposalRow,
  type RoomRow,
  type VoteRow,
} from './mappers.js';
import type { Hub, Presence } from './hub.js';
import type { RoomFlow } from './flow.js';
import type { AgentRow } from '../types.js';
import { broadcastTaskUpdate } from './tasks.js';

export interface ChatContext {
  db: DB;
  hub: Hub;
  presence: Presence;
  flow: RoomFlow;
}

export interface PostMessageArgs {
  roomId: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string | null;
  senderName: string;
  body: string;
  proposal?: SendMessageInput['proposal'];
  taskUpdate?: SendMessageInput['taskUpdate'];
  ip?: string;
}

export function agentsInRoom(db: DB, roomId: string): AgentRow[] {
  return db
    .prepare(`SELECT a.* FROM agents a JOIN agent_rooms ar ON ar.agent_id = a.id WHERE ar.room_id = ?`)
    .all(roomId) as unknown as AgentRow[];
}

export function loadProposalPayload(db: DB, proposalId: string): ProposalPayload | null {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as unknown as ProposalRow | undefined;
  if (!row) return null;
  const votes = db
    .prepare('SELECT * FROM votes WHERE proposal_id = ? ORDER BY created_at')
    .all(proposalId) as unknown as VoteRow[];
  return toProposalPayload(row, votes);
}

function systemMessage(roomId: string, body: string): PublicMessage {
  return {
    id: 0,
    roomId,
    senderType: 'system',
    senderId: null,
    senderName: 'gptchat',
    type: 'system',
    body,
    mentions: [],
    proposal: null,
    createdAt: Date.now(),
  };
}

/** 实时投递一条 @提及（至少一次语义：由 bridge ack 后才落库标记）。 */
function tryRealtimeDeliver(ctx: ChatContext, agent: AgentRow, inboxId: number, message: PublicMessage): void {
  ctx.hub.sendToAgent(agent.id, {
    type: 'agent.mention',
    inboxId,
    agentId: agent.id,
    roomId: message.roomId,
    messageId: message.id,
    from: message.senderName,
    body: message.body,
    proposal: message.proposal,
  });
}

/** 内置回声智能体：零配置演示。延迟回复且引用已剥离 @，服务端另有自我提及过滤，无循环风险。 */
function scheduleEchoReply(ctx: ChatContext, room: RoomRow, agent: AgentRow, original: PublicMessage): void {
  setTimeout(() => {
    try {
      postMessage(ctx, {
        roomId: room.id,
        senderType: 'agent',
        senderId: agent.id,
        senderName: agent.name,
        body: `[echo] 收到 ${original.senderName} 的消息：「${original.body.replace(/@\S+/g, '').slice(0, 120)}」。我是演示用回声智能体；把你的 CLI 接入后，真实智能体即可在此协同。`,
      });
    } catch {
      /* 回声失败不影响主流程 */
    }
  }, 600);
}

/** 用户发言解锁流控：把被 hold 的提及恢复投递。 */
function releaseHeldMentions(ctx: ChatContext, room: RoomRow): void {
  const { db, hub } = ctx;
  const held = db
    .prepare(
      'SELECT i.id AS inbox_id, i.agent_id, m.* FROM inbox i JOIN messages m ON m.seq = i.message_seq WHERE i.room_id = ? AND i.held = 1',
    )
    .all(room.id) as unknown as Array<{ inbox_id: number; agent_id: string } & MessageRow>;
  if (held.length === 0) return;
  db.prepare('UPDATE inbox SET held = 0 WHERE room_id = ? AND held = 1').run(room.id);
  hub.broadcastToRoom(
    room.id,
    { type: 'message.new', message: systemMessage(room.id, '▶️ 用户已发言，被暂停的智能体提及已恢复投递。') },
    { toAgents: false },
  );
  for (const h of held) {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(h.agent_id) as unknown as AgentRow | undefined;
    if (agent) {
      tryRealtimeDeliver(ctx, agent, h.inbox_id, toPublicMessage(h, h.proposal_id ? loadProposalPayload(db, h.proposal_id) : null));
    }
  }
}

/** 消息附带的任务状态更新（可选部分）。权限：房主 / 房间成员用户 / 被指派智能体 / 房间成员智能体。 */
function applyTaskUpdate(
  ctx: ChatContext,
  room: RoomRow,
  roomAgents: AgentRow[],
  args: PostMessageArgs,
  taskUpdate: NonNullable<PostMessageArgs['taskUpdate']>,
  now: number,
): void {
  const { db } = ctx;
  const task = db
    .prepare('SELECT * FROM tasks WHERE id = ? AND room_id = ?')
    .get(taskUpdate.taskId, room.id) as { id: string; assignee_agent_id: string | null } | undefined;
  if (!task) throw notFound('任务不存在');

  const isOwner = args.senderType === 'user' && room.owner_id === args.senderId;
  const isAssignee = args.senderType === 'agent' && task.assignee_agent_id === args.senderId;
  const isMember =
    args.senderType === 'user'
      ? !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, args.senderId)
      : roomAgents.some((a) => a.id === args.senderId);
  if (!isOwner && !isAssignee && !isMember) throw forbidden('无权更新该任务');

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(taskUpdate.status, now, task.id);
  broadcastTaskUpdate(ctx, room.id, task.id);
}

/** 消息附带的分工提案（可选部分）。返回提案载荷。 */
function createProposalRecord(
  ctx: ChatContext,
  room: RoomRow,
  args: PostMessageArgs,
  proposal: NonNullable<PostMessageArgs['proposal']>,
  now: number,
): ProposalPayload {
  const { db, hub } = ctx;
  const id = newId('prop');
  db.prepare(
    `INSERT INTO proposals (id, room_id, title, body, tasks_spec, status, author_type, author_id, author_name, created_at, resolve_by)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    room.id,
    proposal.title,
    proposal.body ?? '',
    JSON.stringify(proposal.tasks),
    args.senderType,
    args.senderId,
    args.senderName,
    now,
    now + PROPOSAL_TTL_MS,
  );
  const payload = loadProposalPayload(db, id);
  if (payload) {
    hub.broadcastToRoom(room.id, { type: 'proposal.update', proposal: payload }, { toAgents: true });
  }
  return payload!;
}

/** 把提及写入收件箱并触发投递/回声（流控锁定时进入 held 状态）。 */
function fanoutToMentioned(
  ctx: ChatContext,
  room: RoomRow,
  message: PublicMessage,
  mentions: PublicMessage['mentions'],
  roomAgents: AgentRow[],
  locked: boolean,
  now: number,
): void {
  const { db } = ctx;
  for (const m of mentions) {
    const agent = roomAgents.find((a) => a.id === m.agentId);
    if (!agent) continue;
    if (agent.kind === 'builtin') {
      if (!locked) scheduleEchoReply(ctx, room, agent, message);
      continue;
    }
    const ins = db
      .prepare(
        'INSERT INTO inbox (agent_id, room_id, message_seq, kind, delivered, held, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      )
      .run(agent.id, room.id, message.id, 'mention', locked ? 1 : 0, now);
    if (!locked) tryRealtimeDeliver(ctx, agent, Number(ins.lastInsertRowid), message);
  }
}

/** 由消息参数推导消息类型。 */
function messageTypeOf(args: PostMessageArgs, hasProposal: boolean): PublicMessage['type'] {
  if (hasProposal) return 'proposal';
  if (args.taskUpdate) return 'task';
  return args.senderType === 'system' ? 'system' : 'chat';
}

/**
 * 消息发送主流水线（REST 唯一写入口；WS 只读）。
 * 步骤：解锁流控 → 提及解析 → 任务更新 → 提案创建 → 入库 → 扇出 → 流控/投递 → 审计。
 */
export function postMessage(ctx: ChatContext, args: PostMessageArgs): PublicMessage {
  const { db, hub, flow } = ctx;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(args.roomId) as unknown as RoomRow | undefined;
  if (!room) throw notFound('房间不存在');
  const now = Date.now();
  const settings = parseSettings(room.settings);

  // 1. 用户消息解锁流控并释放被 hold 的提及
  if (args.senderType === 'user') {
    if (flow.onHumanMessage(room.id)) releaseHeldMentions(ctx, room);
  }

  // 2. 提及解析（防自触发：智能体引用带自己名字的消息不触发自己）
  const roomAgents = agentsInRoom(db, room.id);
  const parsed =
    args.senderType === 'system'
      ? []
      : parseMentions(args.body, roomAgents.map((a) => ({ id: a.id, name: a.name })));
  const mentions = args.senderType === 'agent' ? parsed.filter((m) => m.agentId !== args.senderId) : parsed;

  // 3. 任务状态更新（可选）
  if (args.taskUpdate) {
    applyTaskUpdate(ctx, room, roomAgents, args, args.taskUpdate, now);
  }

  // 4. 提案创建（可选）
  let proposalPayload: ProposalPayload | null = null;
  if (args.proposal) {
    proposalPayload = createProposalRecord(ctx, room, args, args.proposal, now);
  }

  // 5. 入库
  const senderName = args.senderType === 'system' ? 'gptchat' : args.senderName;
  const msgType = messageTypeOf(args, proposalPayload !== null);
  const result = db
    .prepare(
      `INSERT INTO messages (room_id, sender_type, sender_id, sender_name, type, body, mentions, proposal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(room.id, args.senderType, args.senderId, senderName, msgType, args.body, JSON.stringify(mentions), proposalPayload?.id ?? null, now);
  const message: PublicMessage = {
    id: Number(result.lastInsertRowid),
    roomId: room.id,
    senderType: args.senderType,
    senderId: args.senderId,
    senderName,
    type: msgType,
    body: args.body,
    mentions,
    proposal: proposalPayload,
    createdAt: now,
  };

  // 6. 房间扇出（成员 bridge 同步收上下文）
  hub.broadcastToRoom(room.id, { type: 'message.new', message });

  // 7. 智能体流控
  if (args.senderType === 'agent') {
    flow.onAgentMessage(room.id, args.senderId ?? '', settings.maxAgentChain);
    if (flow.isLocked(room.id) && mentions.length > 0) {
      hub.broadcastToRoom(
        room.id,
        { type: 'message.new', message: systemMessage(room.id, `⏸️ 智能体已连续发言 ${settings.maxAgentChain} 条，自动回复暂停；等待用户发言后继续。`) },
        { toAgents: false },
      );
    }
  }

  // 8. 提及投递（锁定时进收件箱但 hold）
  fanoutToMentioned(ctx, room, message, mentions, roomAgents, flow.isLocked(room.id), now);

  // 9. 审计（系统消息量大，不记）
  if (args.senderType !== 'system') {
    audit(db, args.senderType, args.senderId, 'message.post', { room: room.id, seq: message.id, type: msgType, mentions: mentions.length }, args.ip);
  }

  return message;
}

