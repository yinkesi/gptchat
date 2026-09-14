/**
 * gptchat 共享协议常量。
 * 所有数值上限集中在这里，便于部署方按需调整审计。
 */
export const PROTOCOL_VERSION = 1;

/** 消息正文的字节级上限（UTF-8）。防止超大载荷攻击。 */
export const MAX_MESSAGE_BODY = 16_000;
/** 单条消息允许的 @提及数量上限。 */
export const MAX_MENTIONS = 8;
/** 用户名长度限制 */
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 48;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const ROOM_NAME_MAX = 64;
export const ROOM_TOPIC_MAX = 200;
export const AGENT_NAME_MAX = 48;
/** 每用户房间数上限 */
export const MAX_ROOMS_PER_USER = 100;
/** 每房间可接入的智能体数上限 */
export const MAX_AGENTS_PER_ROOM = 24;
/** 每用户智能体数上限 */
export const MAX_AGENTS_PER_USER = 32;
/** 每用户设备数上限 */
export const MAX_DEVICES_PER_USER = 16;
/** 提案中的任务数上限 */
export const MAX_TASKS_PER_PROPOSAL = 12;
/** 提案默认投票时限（毫秒） */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;
/** 房间默认设置：智能体自动回复开关与连续发言上限（防失控循环） */
export const DEFAULT_MAX_AGENT_CHAIN = 8;
/** 智能体两次发言的最小间隔（毫秒） */
export const AGENT_REPLY_COOLDOWN_MS = 1200;
/** 配对请求有效期（毫秒） */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** 会话有效期 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 设备令牌有效期（长期，但可吊销） */
export const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** WebSocket 单条帧上限（字节） */
export const WS_MAX_PAYLOAD = 64 * 1024;
/** REST 请求体上限（字节） */
export const BODY_LIMIT = '256kb';

export const SESSION_COOKIE = 'gptchat_session';

/**
 * 消息类型。
 * - chat       普通聊天
 * - system     系统事件（加入/共识达成等）
 * - proposal   结构化分工提案（含任务列表）
 * - vote       对提案的投票
 * - task       任务状态变更通知
 */
export const MESSAGE_TYPES = ['chat', 'system', 'proposal', 'task'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const AGENT_KINDS = ['bridge', 'api', 'builtin'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_STATUSES = ['offline', 'online'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PROPOSAL_STATUSES = ['open', 'accepted', 'rejected', 'expired'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DEVICE_STATUSES = ['pending', 'approved', 'revoked'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const ROOM_MEMBER_ROLES = ['owner', 'member'] as const;
export type RoomMemberRole = (typeof ROOM_MEMBER_ROLES)[number];
