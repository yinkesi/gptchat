import type {
  PublicAgent,
  PublicMessage,
  PublicRoom,
  PublicUser,
  Mention,
  ProposalPayload,
  RoomSettings,
  TaskPayload,
} from '@gptchat/shared';
import { DEFAULT_MAX_AGENT_CHAIN } from '@gptchat/shared';
import type { AgentRow, UserRow } from '../middleware/auth.js';

export interface RoomRow {
  id: string;
  name: string;
  topic: string;
  owner_id: string;
  settings: string;
  created_at: number;
}

export interface MessageRow {
  seq: number;
  room_id: string;
  sender_type: 'user' | 'agent' | 'system';
  sender_id: string | null;
  sender_name: string;
  type: PublicMessage['type'];
  body: string;
  mentions: string;
  proposal_id: string | null;
  created_at: number;
}

export interface ProposalRow {
  id: string;
  room_id: string;
  title: string;
  body: string;
  tasks_spec: string;
  status: ProposalPayload['status'];
  author_type: 'user' | 'agent';
  author_id: string | null;
  author_name: string;
  created_at: number;
  resolve_by: number;
}

export interface VoteRow {
  proposal_id: string;
  voter_type: 'user' | 'agent';
  voter_id: string;
  voter_name: string;
  choice: 'approve' | 'reject';
  comment: string;
  created_at: number;
}

export interface TaskRow {
  id: string;
  room_id: string;
  proposal_id: string | null;
  title: string;
  status: TaskPayload['status'];
  assignee_agent_id: string | null;
  created_by_type: TaskPayload['createdByType'];
  created_by_id: string | null;
  created_at: number;
  updated_at: number;
}

export function parseSettings(json: string): RoomSettings {
  try {
    const parsed = JSON.parse(json) as Partial<RoomSettings>;
    return {
      agentAutoReply: parsed.agentAutoReply ?? true,
      maxAgentChain: parsed.maxAgentChain ?? DEFAULT_MAX_AGENT_CHAIN,
      consensusRatio: parsed.consensusRatio ?? 0.5,
    };
  } catch {
    return {
      agentAutoReply: true,
      maxAgentChain: DEFAULT_MAX_AGENT_CHAIN,
      consensusRatio: 0.5,
    };
  }
}

export function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

export function toPublicAgent(row: AgentRow): PublicAgent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind as PublicAgent['kind'],
    adapter: row.adapter,
    model: row.model,
    status: row.status as PublicAgent['status'],
    deviceId: row.device_id,
    description: row.description,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function toPublicRoom(row: RoomRow): PublicRoom {
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    ownerId: row.owner_id,
    settings: parseSettings(row.settings),
    createdAt: row.created_at,
  };
}

export function toPublicMessage(row: MessageRow, proposal: ProposalPayload | null): PublicMessage {
  let mentions: Mention[] = [];
  try {
    const parsed: unknown = JSON.parse(row.mentions);
    if (Array.isArray(parsed)) mentions = parsed as Mention[];
  } catch {
    /* 容错：旧数据损坏时按空处理 */
  }
  return {
    id: row.seq,
    roomId: row.room_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    senderName: row.sender_name,
    type: row.type,
    body: row.body,
    mentions,
    proposal,
    createdAt: row.created_at,
  };
}

export function toProposalPayload(
  row: ProposalRow,
  votes: VoteRow[],
  tasks: TaskRow[] = [],
): ProposalPayload {
  let spec: unknown;
  try {
    spec = JSON.parse(row.tasks_spec);
  } catch {
    spec = [];
  }
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    body: row.body,
    tasks: Array.isArray(spec) ? (spec as ProposalPayload['tasks']) : [],
    status: row.status,
    authorType: row.author_type,
    authorId: row.author_id ?? '',
    authorName: row.author_name,
    createdAt: row.created_at,
    resolveBy: row.resolve_by,
    votes: votes.map((v) => ({
      voterType: v.voter_type,
      voterId: v.voter_id,
      voterName: v.voter_name,
      choice: v.choice,
      createdAt: v.created_at,
    })),
    // 接受后生成的任务摘要，便于前端渲染
    ...(tasks.length
      ? { taskPreviews: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })) }
      : {}),
  };
}

export function toTaskPayload(row: TaskRow, assigneeName: string | null): TaskPayload {
  return {
    id: row.id,
    roomId: row.room_id,
    proposalId: row.proposal_id,
    title: row.title,
    status: row.status,
    assigneeAgentId: row.assignee_agent_id,
    assigneeName,
    createdByType: row.created_by_type,
    createdById: row.created_by_id ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
