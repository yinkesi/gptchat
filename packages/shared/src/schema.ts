import { z } from 'zod';
import {
  AGENT_KINDS,
  AGENT_NAME_MAX,
  AGENT_REPLY_COOLDOWN_MS,
  DEFAULT_MAX_AGENT_CHAIN,
  MAX_AGENTS_PER_ROOM,
  MAX_MENTIONS,
  MAX_MESSAGE_BODY,
  MAX_TASKS_PER_PROPOSAL,
  MESSAGE_TYPES,
  ROOM_NAME_MAX,
  ROOM_TOPIC_MAX,
} from './constants.js';

// ---------- 基础实体（服务器输出的公开形态，绝不包含令牌/散列） ----------

export const PublicUser = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  createdAt: z.number(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const PublicAgent = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  kind: z.enum(AGENT_KINDS),
  /** 适配器标识，如 claude / codex / gemini / echo / generic */
  adapter: z.string(),
  model: z.string().nullable(),
  status: z.enum(['offline', 'online']),
  deviceId: z.string().nullable(),
  description: z.string().default(''),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
});
export type PublicAgent = z.infer<typeof PublicAgent>;

export const RoomSettings = z.object({
  /** 是否允许智能体被 @ 后自动回复 */
  agentAutoReply: z.boolean().default(true),
  /** 连续智能体发言上限，超过后暂停自动投递直到有用户发言（防失控） */
  maxAgentChain: z.number().int().min(1).max(50).default(DEFAULT_MAX_AGENT_CHAIN),
  /** 提案通过所需的在线智能体赞成比例（0 < x <= 1） */
  consensusRatio: z.number().min(0.01).max(1).default(0.5),
});
export type RoomSettings = z.infer<typeof RoomSettings>;

export const PublicRoom = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string(),
  ownerId: z.string(),
  settings: RoomSettings,
  createdAt: z.number(),
});
export type PublicRoom = z.infer<typeof PublicRoom>;

export const Mention = z.object({
  agentId: z.string(),
  name: z.string(),
});
export type Mention = z.infer<typeof Mention>;

export const ProposalTaskSpec = z.object({
  title: z.string().min(1).max(200),
  /** 期望的负责智能体名称（创建时可只给名字，由服务器解析） */
  assigneeName: z.string().max(100).optional(),
  assigneeAgentId: z.string().optional(),
});
export type ProposalTaskSpec = z.infer<typeof ProposalTaskSpec>;

export const ProposalPayload = z.object({
  id: z.string(),
  roomId: z.string(),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).default(''),
  tasks: z.array(ProposalTaskSpec).max(MAX_TASKS_PER_PROPOSAL),
  status: z.enum(['open', 'accepted', 'rejected', 'expired']),
  authorType: z.enum(['user', 'agent']),
  authorId: z.string(),
  authorName: z.string(),
  createdAt: z.number(),
  resolveBy: z.number(),
  votes: z.array(
    z.object({
      voterType: z.enum(['user', 'agent']),
      voterId: z.string(),
      voterName: z.string(),
      choice: z.enum(['approve', 'reject']),
      createdAt: z.number(),
    }),
  ),
  /** 提案被接受后生成的任务摘要（可选，便于前端渲染） */
  taskPreviews: z
    .array(z.object({ id: z.string(), title: z.string(), status: z.enum(['pending', 'in_progress', 'done', 'cancelled']) }))
    .optional(),
});
export type ProposalPayload = z.infer<typeof ProposalPayload>;

export const TaskPayload = z.object({
  id: z.string(),
  roomId: z.string(),
  proposalId: z.string().nullable(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done', 'cancelled']),
  assigneeAgentId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  createdByType: z.enum(['user', 'agent', 'system']),
  createdById: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TaskPayload = z.infer<typeof TaskPayload>;

export const PublicMessage = z.object({
  id: z.number(),
  roomId: z.string(),
  senderType: z.enum(['user', 'agent', 'system']),
  senderId: z.string().nullable(),
  senderName: z.string(),
  /** 发送者头像用的渐变色索引（前端按 id hash 亦可，这里由服务器统一） */
  type: z.enum(MESSAGE_TYPES),
  body: z.string(),
  mentions: z.array(Mention).max(MAX_MENTIONS),
  proposal: ProposalPayload.nullable(),
  createdAt: z.number(),
});
export type PublicMessage = z.infer<typeof PublicMessage>;

// ---------- REST / WS 输入校验 ----------

export const RegisterInput = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, '用户名仅允许字母、数字、下划线和中划线'),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(48).optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const CreateRoomInput = z.object({
  name: z.string().min(1).max(ROOM_NAME_MAX).trim(),
  topic: z.string().max(ROOM_TOPIC_MAX).trim().default(''),
  agentIds: z.array(z.string()).max(MAX_AGENTS_PER_ROOM).optional(),
  /** 创建同时加入一个内置演示回声智能体（零配置体验） */
  withDemoAgent: z.boolean().optional(),
});
export type CreateRoomInput = z.infer<typeof CreateRoomInput>;

export const UpdateRoomInput = z.object({
  topic: z.string().max(ROOM_TOPIC_MAX).trim().optional(),
  settings: RoomSettings.partial().optional(),
});
export type UpdateRoomInput = z.infer<typeof UpdateRoomInput>;

export const CreateAgentInput = z.object({
  name: z.string().min(1).max(48).trim().regex(/^[\w\u4e00-\u9fa5 .-]+$/, '名称含非法字符'),
  kind: z.enum(AGENT_KINDS).default('api'),
  adapter: z.string().max(32).default('generic'),
  model: z.string().max(64).optional(),
  description: z.string().max(300).default(''),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

export const SendMessageInput = z.object({
  body: z.string().min(1).max(MAX_MESSAGE_BODY),
  /** 结构化提案：与 body 一起提交，type 自动变为 proposal */
  proposal: z
    .object({
      title: z.string().min(1).max(200),
      body: z.string().max(4000).default(''),
      tasks: z.array(ProposalTaskSpec).max(MAX_TASKS_PER_PROPOSAL),
    })
    .optional(),
  /** 任务状态更新：与 body 一起提交，type 自动变为 task */
  taskUpdate: z
    .object({
      taskId: z.string(),
      status: z.enum(['pending', 'in_progress', 'done', 'cancelled']),
    })
    .optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const VoteInput = z.object({
  proposalId: z.string(),
  choice: z.enum(['approve', 'reject']),
  comment: z.string().max(1000).default(''),
});
export type VoteInput = z.infer<typeof VoteInput>;

export const ResolveProposalInput = z.object({
  decision: z.enum(['accepted', 'rejected', 'expired']),
});
export type ResolveProposalInput = z.infer<typeof ResolveProposalInput>;

// ---------- WebSocket 协议 ----------

/** 客户端 → 服务器 */
export const C2SEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room.join'), roomId: z.string() }),
  z.object({ type: z.literal('room.leave'), roomId: z.string() }),
  z.object({ type: z.literal('typing'), roomId: z.string() }),
  /** bridge 确认收到提及投递（至少一次投递语义） */
  z.object({ type: z.literal('inbox.ack'), ids: z.array(z.number().int().positive()).max(200) }),
]);
export type C2SEvent = z.infer<typeof C2SEvent>;

/** 服务器 → 客户端 */
export type S2CEvent =
  | { type: 'hello'; protocol: number; userId?: string; agentIds?: string[] }
  | { type: 'message.new'; message: PublicMessage }
  | { type: 'typing'; roomId: string; who: string }
  | {
      type: 'agent.mention';
      /** inbox 行号：bridge 处理后应 ack，未 ack 的重连后会重投 */
      inboxId: number;
      /** 被提及的智能体（bridge 据此选择本地 CLI） */
      agentId: string;
      roomId: string;
      messageId: number;
      from: string;
      body: string;
      proposal: ProposalPayload | null;
    }
  | { type: 'presence'; agents: Array<{ agentId: string; status: 'online' | 'offline' }> }
  | { type: 'proposal.update'; proposal: ProposalPayload }
  | { type: 'task.update'; task: TaskPayload }
  | { type: 'error'; code: string; message: string };

// ---------- 设备配对 ----------

export const PairRequestInput = z.object({
  pairCode: z.string().regex(/^[A-Z0-9]{6}$/),
  machineName: z.string().min(1).max(64).trim(),
  platform: z.string().max(64),
  /** 本机探测到的智能体候选（只含名称/类型，不读取任何私有数据） */
  candidates: z
    .array(
      z.object({
        name: z.string().min(1).max(AGENT_NAME_MAX),
        adapter: z.string().min(1).max(32),
        model: z.string().max(64).optional(),
      }),
    )
    .max(12),
});
export type PairRequestInput = z.infer<typeof PairRequestInput>;

export const PairCandidate = z.object({
  name: z.string(),
  adapter: z.string(),
  model: z.string().optional(),
  approved: z.boolean(),
  /** 批准后下发，仅此一次 */
  agentToken: z.string().optional(),
  agentId: z.string().optional(),
});
export type PairCandidate = z.infer<typeof PairCandidate>;

export const PairRequestView = z.object({
  id: z.string(),
  pairCode: z.string(),
  machineName: z.string(),
  platform: z.string(),
  candidates: z.array(PairCandidate),
  status: z.enum(['pending', 'approved', 'revoked']),
  requestedAt: z.number(),
});
export type PairRequestView = z.infer<typeof PairRequestView>;

