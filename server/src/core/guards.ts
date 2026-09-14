import type { DB } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import type { RoomRow } from './mappers.js';
import type { AgentRow } from '../types.js';

/**
 * 成员资格守卫：房间可见性/成员关系的唯一判定处。
 * 路由层只调用这里，不再各自手写 SQL 判断，避免授权逻辑漂移。
 */

export function roomById(db: DB, roomId: string): RoomRow {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as unknown as RoomRow | undefined;
  if (!room) throw notFound('房间不存在');
  return room;
}

/** 用户必须是房间成员，否则 404/403。返回房间与角色。 */
export function roomMember(db: DB, roomId: string, userId: string): { room: RoomRow; role: string } {
  const room = roomById(db, roomId);
  const member = db
    .prepare('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId) as { role: string } | undefined;
  if (!member) throw forbidden('不是该房间成员');
  return { room, role: member.role };
}

export function agentInRoom(db: DB, roomId: string, agentId: string): boolean {
  return !!db.prepare('SELECT 1 FROM agent_rooms WHERE room_id = ? AND agent_id = ?').get(roomId, agentId);
}

