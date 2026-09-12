import type { TaskPayload } from '@gptchat/shared';
import type { DB } from '../db.js';
import { toTaskPayload, type TaskRow } from './mappers.js';
import type { ChatContext } from './chat.js';

/**
 * 任务域：任务的读取、载荷组装与状态广播。
 * 职责归属：mappers 保持纯映射，这里做带 DB 访问的领域操作。
 */

/** 行 → 公开载荷（自动补负责人名，一处实现，多处复用）。 */
export function taskToPayload(db: DB, row: TaskRow): TaskPayload {
  let assigneeName: string | null = null;
  if (row.assignee_agent_id) {
    const a = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.assignee_agent_id) as
      | { name: string }
      | undefined;
    assigneeName = a?.name ?? null;
  }
  return toTaskPayload(row, assigneeName);
}

/** 广播任务最新状态给房间（含成员 bridge）。 */
export function broadcastTaskUpdate(ctx: ChatContext, roomId: string, taskId: string): void {
  const row = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as TaskRow | undefined;
  if (!row) return;
  ctx.hub.broadcastToRoom(roomId, { type: 'task.update', task: taskToPayload(ctx.db, row) }, { toAgents: true });
}

/** 房间任务列表（按创建时间升序）。 */
export function listTasks(db: DB, roomId: string): TaskPayload[] {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at ASC LIMIT 200')
    .all(roomId) as unknown as TaskRow[];
  return rows.map((t) => taskToPayload(db, t));
}
