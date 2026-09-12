import type { WebSocket } from 'ws';
import type { DB } from '../db.js';
import type { S2CEvent } from '@gptchat/shared';
import type { AgentRow } from '../middleware/auth.js';

/** ws readyState 常量（避免将类型当值使用） */
const WS_OPEN = 1;

export type SocketIdentity =
  | { kind: 'user'; userId: string }
  | { kind: 'device'; deviceId: string; ownerId: string; agentIds: string[] }
  | { kind: 'agent'; agentId: string; ownerId: string };

export interface GptSocket extends WebSocket {
  identity?: SocketIdentity;
  rooms: Set<string>;
  alive: boolean;
  rate: { count: number; resetAt: number };
}

/**
 * 实时事件中心：把消息/状态变更扇出到
 *  - 已加入房间的用户 socket
 *  - 房间成员智能体对应的 bridge/agent socket
 * 单进程内存实现；未来横向扩展时替换为 Redis pub/sub 即可，接口不变。
 */
export class Hub {
  private userSocks = new Map<string, Set<GptSocket>>();
  private agentSocks = new Map<string, Set<GptSocket>>();
  private roomUserSocks = new Map<string, Set<GptSocket>>();

  constructor(private db: DB) {}

  attachUser(userId: string, sock: GptSocket): void {
    sock.identity = { kind: 'user', userId };
    let set = this.userSocks.get(userId);
    if (!set) this.userSocks.set(userId, (set = new Set()));
    set.add(sock);
  }

  attachAgentSockets(agentIds: string[], sock: GptSocket): void {
    for (const agentId of agentIds) {
      let set = this.agentSocks.get(agentId);
      if (!set) this.agentSocks.set(agentId, (set = new Set()));
      set.add(sock);
    }
  }

  detach(sock: GptSocket): void {
    if (sock.identity?.kind === 'user') {
      this.userSocks.get(sock.identity.userId)?.delete(sock);
    }
    if (sock.identity && sock.identity.kind !== 'user') {
      const ids = sock.identity.kind === 'device' ? sock.identity.agentIds : [sock.identity.agentId];
      for (const id of ids) this.agentSocks.get(id)?.delete(sock);
    }
    for (const roomId of sock.rooms) this.roomUserSocks.get(roomId)?.delete(sock);
    sock.rooms.clear();
  }

  joinRoom(sock: GptSocket, roomId: string): void {
    sock.rooms.add(roomId);
    let set = this.roomUserSocks.get(roomId);
    if (!set) this.roomUserSocks.set(roomId, (set = new Set()));
    set.add(sock);
  }

  leaveRoom(sock: GptSocket, roomId: string): void {
    sock.rooms.delete(roomId);
    this.roomUserSocks.get(roomId)?.delete(sock);
  }

  send(sock: GptSocket, event: S2CEvent): boolean {
    if (sock.readyState !== WS_OPEN) return false;
    try {
      sock.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  /** 发给房间内所有已加入的用户 socket；opts.toAgents 控制是否同步给成员智能体的 bridge。 */
  broadcastToRoom(roomId: string, event: S2CEvent, opts: { toAgents?: boolean } = {}): void {
    for (const sock of this.roomUserSocks.get(roomId) ?? []) this.send(sock, event);
    if (opts.toAgents !== false) {
      for (const sock of this.agentSocksInRoom(roomId)) this.send(sock, event);
    }
  }

  /** 找到房间成员智能体对应的 socket（去重：一个 bridge 可服务多个智能体）。 */
  private agentSocksInRoom(roomId: string): Set<GptSocket> {
    const socks = new Set<GptSocket>();
    const rows = this.db.prepare('SELECT agent_id FROM agent_rooms WHERE room_id = ?').all(roomId) as Array<{
      agent_id: string;
    }>;
    for (const r of rows) {
      for (const sock of this.agentSocks.get(r.agent_id) ?? []) socks.add(sock);
    }
    return socks;
  }

  /** 点对点投递给某个智能体（经其 bridge 或直连 socket）。 */
  sendToAgent(agentId: string, event: S2CEvent): boolean {
    for (const sock of this.agentSocks.get(agentId) ?? []) {
      if (this.send(sock, event)) return true;
    }
    return false;
  }

  hasLiveSocket(agentId: string): boolean {
    for (const sock of this.agentSocks.get(agentId) ?? []) {
      if (sock.readyState === WS_OPEN) return true;
    }
    return false;
  }

  /** 立即断开服务某智能体的所有 socket（设备吊销时调用）。 */
  dropAgentSockets(agentId: string): void {
    for (const sock of this.agentSocks.get(agentId) ?? []) {
      try {
        sock.close(4001, 'device revoked');
      } catch {
        sock.terminate();
      }
    }
    this.agentSocks.delete(agentId);
  }

  roomUserCount(roomId: string): number {
    return [...(this.roomUserSocks.get(roomId) ?? [])].filter((s) => s.readyState === WS_OPEN).length;
  }
}

/**
 * 智能体在线状态：引用计数（一个 bridge 可能重连/多开）。
 * 状态变更持久化并广播给智能体所在房间。
 */
export class Presence {
  private refs = new Map<string, number>();

  constructor(
    private db: DB,
    private hub: Hub,
  ) {}

  online(agentId: string): void {
    this.refs.set(agentId, (this.refs.get(agentId) ?? 0) + 1);
    if (this.refs.get(agentId) === 1) this.persist(agentId, 'online');
  }

  offline(agentId: string): void {
    const n = (this.refs.get(agentId) ?? 0) - 1;
    if (n <= 0) {
      this.refs.delete(agentId);
      this.persist(agentId, 'offline');
    } else {
      this.refs.set(agentId, n);
    }
  }

  private persist(agentId: string, status: 'online' | 'offline'): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?')
      .run(status, now, agentId);
    const rooms = this.db.prepare('SELECT room_id FROM agent_rooms WHERE agent_id = ?').all(agentId) as Array<{
      room_id: string;
    }>;
    for (const r of rooms) {
      this.hub.broadcastToRoom(r.room_id, { type: 'presence', agents: [{ agentId, status }] }, { toAgents: false });
    }
  }
}

/** 由 agent 行构造 presence 广播所需的载荷。 */
export function agentStatus(a: AgentRow): { agentId: string; status: 'online' | 'offline' } {
  return { agentId: a.id, status: a.status === 'online' ? 'online' : 'offline' };
}
