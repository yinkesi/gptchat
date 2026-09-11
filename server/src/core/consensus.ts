import type { ProposalPayload, TaskPayload } from '@gptchat/shared';
import { PROPOSAL_TTL_MS } from '@gptchat/shared';
import type { DB } from '../db.js';
import { audit } from '../db.js';
import { newId } from '../crypto.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { toProposalPayload, toTaskPayload, type ProposalRow, type RoomRow, type TaskRow, type VoteRow } from './mappers.js';
import { agentsInRoom, postMessage, type ChatContext } from './chat.js';
import type { AgentRow } from '../middleware/auth.js';

export interface Voter {
  type: 'agent';
  id: string;
  name: string;
}

/**
 * 共识规则（可按房间配置 consensusRatio，默认 0.5）：
 *  - 有投票资格者 = 房间内的全体智能体（含离线 —— 离线者回来仍可补票）；
 *  - 赞成票数 >= ceil(eligible × ratio) 即通过；
 *  - 反对票数 > eligible − 所需赞成数 即数学上不可能通过，立即否决；
 *  - 超时未决 → expired。房主可强制通过/否决（作为人类兜底）。
 */
export function tally(
  eligible: number,
  approve: number,
  reject: number,
  ratio: number,
): 'open' | 'accepted' | 'rejected' {
  const needed = Math.max(1, Math.ceil(eligible * ratio));
  if (approve >= needed) return 'accepted';
  if (reject > eligible - needed) return 'rejected';
  return 'open';
}

function getProposal(db: DB, proposalId: string): ProposalRow {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposalId) as unknown as ProposalRow | undefined;
  if (!row) throw notFound('提案不存在');
  return row;
}

function getRoom(db: DB, roomId: string): RoomRow {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as unknown as RoomRow | undefined;
  if (!row) throw notFound('房间不存在');
  return row;
}

function proposalWithVotes(db: DB, row: ProposalRow, tasks: TaskRow[] = []): ProposalPayload {
  const votes = db
    .prepare('SELECT * FROM votes WHERE proposal_id = ? ORDER BY created_at')
    .all(row.id) as unknown as VoteRow[];
  return toProposalPayload(row, votes, tasks);
}

function createTasksFromProposal(
  ctx: ChatContext,
  room: RoomRow,
  proposal: ProposalRow,
): TaskRow[] {
  let specs: Array<{ title: string; assigneeName?: string; assigneeAgentId?: string }> = [];
  try {
    const parsed: unknown = JSON.parse(proposal.tasks_spec);
    if (Array.isArray(parsed)) specs = parsed as typeof specs;
  } catch {
    specs = [];
  }
  const roomAgents = agentsInRoom(ctx.db, room.id);
  const now = Date.now();
  const created: TaskRow[] = [];
  for (const spec of specs.slice(0, 12)) {
    let assignee: AgentRow | undefined;
    const assigneeNameLower = spec.assigneeName?.toLowerCase();
    if (spec.assigneeAgentId) {
      assignee = roomAgents.find((a) => a.id === spec.assigneeAgentId);
    } else if (assigneeNameLower) {
      assignee = roomAgents.find((a) => a.name.toLowerCase() === assigneeNameLower);
    }
    const id = newId('task');
    ctx.db
      .prepare(
        `INSERT INTO tasks (id, room_id, proposal_id, title, status, assignee_agent_id, created_by_type, created_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, 'system', NULL, ?, ?)`,
      )
      .run(id, room.id, proposal.id, spec.title, assignee?.id ?? null, now, now);
    created.push(
      ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow,
    );
  }
  return created;
}

function resolveAndBroadcast(
  ctx: ChatContext,
  proposal: ProposalRow,
  decision: 'accepted' | 'rejected' | 'expired',
  actor: { type: 'user' | 'agent' | 'system'; id: string | null; name: string },
): ProposalPayload {
  const now = Date.now();
  ctx.db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(decision, proposal.id);
  const room = getRoom(ctx.db, proposal.room_id);

  let tasks: TaskRow[] = [];
  if (decision === 'accepted') {
    tasks = createTasksFromProposal(ctx, room, proposal);
  }

  const payload = proposalWithVotes(ctx.db, { ...proposal, status: decision }, tasks);
  ctx.hub.broadcastToRoom(ctx.db, room.id, { type: 'proposal.update', proposal: payload }, { toAgents: true });

  for (const t of tasks) {
    let assigneeName: string | null = null;
    if (t.assignee_agent_id) {
      const a = ctx.db.prepare('SELECT name FROM agents WHERE id = ?').get(t.assignee_agent_id) as
        | { name: string }
        | undefined;
      assigneeName = a?.name ?? null;
    }
    ctx.hub.broadcastToRoom(ctx.db, room.id, { type: 'task.update', task: toTaskPayload(t, assigneeName) }, { toAgents: true });
  }

  const emoji = decision === 'accepted' ? '✅' : decision === 'rejected' ? '❌' : '⏰';
  const label = decision === 'accepted' ? '共识达成' : decision === 'rejected' ? '共识未达成（已否决）' : '提案超时关闭';
  const taskNote =
    decision === 'accepted' && tasks.length > 0
      ? `\n已生成分工：` + tasks.map((t, i) => `\n${i + 1}. ${t.title}${t.assignee_agent_id ? ` → @${(ctx.db.prepare('SELECT name FROM agents WHERE id = ?').get(t.assignee_agent_id) as { name: string } | undefined)?.name ?? ''}` : ''}`).join('')
      : '';
  postMessage(ctx, {
    roomId: room.id,
    senderType: 'system',
    senderId: null,
    senderName: 'gptchat',
    body: `${emoji} ${label}：《${proposal.title}》（由 ${proposal.author_name} 发起，${actor.name} 完成判定）${taskNote}`,
  });

  audit(ctx.db, actor.type, actor.id, 'proposal.resolved', { proposal: proposal.id, decision });
  return payload;
}

/** 智能体投票。 */
export function castVote(
  ctx: ChatContext,
  proposalId: string,
  voter: Voter,
  choice: 'approve' | 'reject',
  comment: string,
  ip?: string,
): ProposalPayload {
  const proposal = getProposal(ctx.db, proposalId);
  if (proposal.status !== 'open') throw conflict('提案已关闭');
  const room = getRoom(ctx.db, proposal.room_id);

  const roomAgents = agentsInRoom(ctx.db, room.id);
  const voterAgent = roomAgents.find((a) => a.id === voter.id);
  if (!voterAgent) throw forbidden('只有房间内的智能体可以投票');

  const dup = ctx.db
    .prepare('SELECT 1 FROM votes WHERE proposal_id = ? AND voter_type = ? AND voter_id = ?')
    .get(proposalId, 'agent', voter.id);
  if (dup) throw conflict('该智能体已投过票');

  ctx.db
    .prepare(
      `INSERT INTO votes (proposal_id, voter_type, voter_id, voter_name, choice, comment, created_at)
       VALUES (?, 'agent', ?, ?, ?, ?, ?)`,
    )
    .run(proposalId, voter.id, voter.name, choice, comment, Date.now());
  audit(ctx.db, 'agent', voter.id, 'proposal.vote', { proposal: proposalId, choice }, ip);

  const settings = JSON.parse(room.settings) as { consensusRatio?: number };
  const eligible = roomAgents.length;
  const counts = ctx.db
    .prepare(
      `SELECT choice, COUNT(*) AS n FROM votes WHERE proposal_id = ? GROUP BY choice`,
    )
    .all(proposalId) as Array<{ choice: string; n: number }>;
  const approve = counts.find((c) => c.choice === 'approve')?.n ?? 0;
  const reject = counts.find((c) => c.choice === 'reject')?.n ?? 0;
  const verdict = tally(eligible, approve, reject, settings.consensusRatio ?? 0.5);

  if (verdict === 'open') {
    const payload = proposalWithVotes(ctx.db, proposal);
    ctx.hub.broadcastToRoom(ctx.db, room.id, { type: 'proposal.update', proposal: payload }, { toAgents: true });
    return payload;
  }
  return resolveAndBroadcast(ctx, proposal, verdict, { type: 'agent', id: voter.id, name: voter.name });
}

/** 房主强制判定（人类兜底）。 */
export function forceResolve(
  ctx: ChatContext,
  proposalId: string,
  userId: string,
  username: string,
  decision: 'accepted' | 'rejected',
): ProposalPayload {
  const proposal = getProposal(ctx.db, proposalId);
  const room = getRoom(ctx.db, proposal.room_id);
  if (room.owner_id !== userId) throw forbidden('只有房主可以强制判定提案');
  if (proposal.status !== 'open') throw conflict('提案已关闭');
  return resolveAndBroadcast(ctx, proposal, decision, { type: 'user', id: userId, name: username });
}

/** 周期清扫：超时提案自动关闭。返回处理数量（供测试断言）。 */
export function sweepExpiredProposals(ctx: ChatContext): number {
  const now = Date.now();
  const rows = ctx.db
    .prepare("SELECT * FROM proposals WHERE status = 'open' AND resolve_by < ?")
    .all(now) as unknown as ProposalRow[];
  for (const row of rows) {
    resolveAndBroadcast(ctx, row, 'expired', { type: 'system', id: null, name: 'gptchat' });
  }
  return rows.length;
}

/** 读取房间的提案列表（含票据），按创建时间倒序。 */
export function listProposals(db: DB, roomId: string): ProposalPayload[] {
  const rows = db
    .prepare('SELECT * FROM proposals WHERE room_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(roomId) as unknown as ProposalRow[];
  return rows.map((r) => proposalWithVotes(db, r));
}

/** 读取房间任务列表。 */
export function listTasks(db: DB, roomId: string): TaskPayload[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(roomId) as unknown as Array<TaskRow & { assignee_name?: string | null }>;
  return rows.map((t) => {
    let assigneeName: string | null = null;
    if (t.assignee_agent_id) {
      const a = db.prepare('SELECT name FROM agents WHERE id = ?').get(t.assignee_agent_id) as
        | { name: string }
        | undefined;
      assigneeName = a?.name ?? null;
    }
    return toTaskPayload(t, assigneeName);
  });
}

export { PROPOSAL_TTL_MS };
