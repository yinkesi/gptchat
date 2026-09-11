import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  C2SEvent,
  PROTOCOL_VERSION,
  SESSION_COOKIE,
  WS_MAX_PAYLOAD,
  type S2CEvent,
} from '@gptchat/shared';
import { getDb } from '../db.js';
import { hashToken } from '../crypto.js';
import { deviceById, userById, verifyJwt, type DeviceRow } from '../middleware/auth.js';
import { Hub, Presence, type GptSocket, type SocketIdentity } from '../core/hub.js';
import type { RoomFlow } from '../core/flow.js';

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function resolveIdentity(db: ReturnType<typeof getDb>, req: IncomingMessage): SocketIdentity | null {
  const bearer = bearerOf(req);
  const cookieToken = parseCookie(req.headers.cookie ?? '', SESSION_COOKIE);

  for (const token of [bearer, cookieToken]) {
    if (!token) continue;
    if (token.startsWith('gptc_')) {
      // 智能体令牌（数据库散列比对）
      const agent = db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(hashToken(token)) as
        | { id: string; owner_id: string; device_id: string | null }
        | undefined;
      if (!agent) continue;
      if (agent.device_id) {
        const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(agent.device_id) as unknown as DeviceRow | undefined;
        if (!dev || dev.status !== 'approved' || !dev.token_hash) continue;
      }
      return { kind: 'agent', agentId: agent.id, ownerId: agent.owner_id };
    }
    const payload = verifyJwt(token);
    if (!payload) continue;
    if (payload.typ === 'session') {
      const user = userById(db, payload.sub);
      if (user) return { kind: 'user', userId: user.id };
    } else if (payload.typ === 'device') {
      const dev = deviceById(db, payload.sub);
      if (dev && dev.status === 'approved') {
        const agentIds = (db.prepare('SELECT id FROM agents WHERE device_id = ?').all(dev.id) as Array<{ id: string }>).map(
          (r) => r.id,
        );
        return { kind: 'device', deviceId: dev.id, ownerId: dev.owner_id ?? '', agentIds };
      }
    }
  }
  return null;
}

/** 补发未投递的提及（bridge 重连后的 at-least-once 保障，处理完成后由 inbox.ack 确认）。 */
function sendBacklog(db: ReturnType<typeof getDb>, hub: Hub, agentIds: string[], sock: GptSocket): void {
  for (const agentId of agentIds) {
    const rows = db
      .prepare(
        `SELECT i.id AS inbox_id, i.agent_id, m.seq, m.room_id, m.sender_name, m.body
         FROM inbox i JOIN messages m ON m.seq = i.message_seq
         WHERE i.agent_id = ? AND i.delivered = 0 AND i.held = 0
         ORDER BY i.id ASC LIMIT 50`,
      )
      .all(agentId) as Array<{
      inbox_id: number;
      seq: number;
      room_id: string;
      sender_name: string;
      body: string;
    }>;
    for (const r of rows) {
      hub.send(sock, {
        type: 'agent.mention',
        inboxId: r.inbox_id,
        agentId,
        roomId: r.room_id,
        messageId: r.seq,
        from: r.sender_name,
        body: r.body,
        proposal: null,
      });
    }
  }
}

export function setupGateway(
  server: HttpServer,
  hub: Hub,
  presence: Presence,
  _flow: RoomFlow,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  const onConnection = (wsRaw: WebSocket, identity: SocketIdentity): void => {
    const ws = wsRaw as unknown as GptSocket;
    const db = getDb();
    ws.identity = identity;
    ws.rooms = new Set();
    ws.alive = true;
    ws.rate = { count: 0, resetAt: Date.now() + 10_000 };

    const agentIds: string[] =
      identity.kind === 'device' ? identity.agentIds : identity.kind === 'agent' ? [identity.agentId] : [];

    if (identity.kind === 'user') {
      hub.attachUser(identity.userId, ws);
    } else {
      hub.attachAgentSockets(agentIds, ws);
      for (const id of agentIds) presence.online(id);
    }

    const hello: S2CEvent = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      userId: identity.kind === 'user' ? identity.userId : undefined,
      agentIds: identity.kind === 'user' ? undefined : agentIds,
    };
    hub.send(ws, hello);

    if (agentIds.length > 0) sendBacklog(db, hub, agentIds, ws);

    ws.on('pong', () => {
      ws.alive = true;
    });

    ws.on('message', (raw) => {
      // 每连接事件限速：20 条 / 10s，超限断开（防滥用）
      const now = Date.now();
      if (now > ws.rate.resetAt) {
        ws.rate.count = 0;
        ws.rate.resetAt = now + 10_000;
      }
      if (++ws.rate.count > 20) {
        hub.send(ws, { type: 'error', code: 'RATE_LIMITED', message: '事件过于频繁，连接被关闭' });
        ws.close(1008, 'rate limited');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        hub.send(ws, { type: 'error', code: 'BAD_REQUEST', message: '无效 JSON' });
        return;
      }
      const event = C2SEvent.safeParse(parsed);
      if (!event.success) {
        hub.send(ws, { type: 'error', code: 'BAD_REQUEST', message: '不支持的事件' });
        return;
      }

      switch (event.data.type) {
        case 'room.join': {
          if (identity.kind !== 'user') return;
          const member = db
            .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
            .get(event.data.roomId, identity.userId);
          if (!member) {
            hub.send(ws, { type: 'error', code: 'FORBIDDEN', message: '不是该房间成员' });
            return;
          }
          hub.joinRoom(ws, event.data.roomId);
          break;
        }
        case 'room.leave': {
          hub.leaveRoom(ws, event.data.roomId);
          break;
        }
        case 'typing': {
          if (identity.kind !== 'user') return;
          hub.broadcastToRoom(
            db,
            event.data.roomId,
            { type: 'typing', roomId: event.data.roomId, who: identity.userId },
            { toAgents: false },
          );
          break;
        }
        case 'inbox.ack': {
          if (identity.kind === 'user') return;
          if (event.data.ids.length > 0) {
            // 只允许 ack 自己（设备名下）智能体的收件箱，防越权标记
            const own = identity.kind === 'device' ? identity.agentIds : [identity.agentId];
            const ownMarks = own.map(() => '?').join(',');
            const idMarks = event.data.ids.map(() => '?').join(',');
            db.prepare(
              `UPDATE inbox SET delivered = 1 WHERE id IN (${idMarks}) AND agent_id IN (${ownMarks})`,
            ).run(...event.data.ids, ...own);
          }
          break;
        }
      }
    });

    const cleanup = (): void => {
      hub.detach(ws);
      for (const id of agentIds) presence.offline(id);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const identity = resolveIdentity(getDb(), req);
    if (!identity) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws as unknown as WebSocket, identity));
  });

  // 心跳：30s 清理死连接
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const sock = ws as unknown as GptSocket;
      if (!sock.alive) {
        sock.terminate();
        continue;
      }
      sock.alive = false;
      try {
        sock.ping();
      } catch {
        sock.terminate();
      }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(timer));

  return wss;
}
