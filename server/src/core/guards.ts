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

/** 用户必须是房主（在已是成员的前提下）。 */
export function roomOwner(db: DB, roomId: string, userId: string): RoomRow {
  const { room, role } = roomMember(db, roomId, userId);
  if (role !== 'owner') throw forbidden('只有房主可以执行此操作');
  return room;
}

export function agentInRoom(db: DB, roomId: string, agentId: string): boolean {
  return !!db.prepare('SELECT 1 FROM agent_rooms WHERE room_id = ? AND agent_id = ?').get(roomId, agentId);
}

/** 设备主体：其名下任一智能体在房间里即可（bridge 需要同步上下文）。 */
export function deviceTouchesRoom(db: DB, roomId: string, agentIds: string[]): boolean {
  return agentIds.some((aid) => agentInRoom(db, roomId, aid));
}

/** 房间内全体智能体（含离线）。 */
export function agentsOfRoom(db: DB, roomId: string): AgentRow[] {
  return db
    .prepare(`SELECT a.* FROM agents a JOIN agent_rooms ar ON ar.agent_id = a.id WHERE ar.room_id = ? ORDER BY a.name`)
    .all(roomId) as unknown as AgentRow[];
}
