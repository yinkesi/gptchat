import { Router } from 'express';
import { ResolveProposalInput, VoteInput } from '@gptchat/shared';
import { getDb, audit } from '../db.js';
import { forbidden, notFound, unauthorized } from '../errors.js';
import { dbOf, requireAgent, requireUser } from '../middleware/auth.js';
import { validated, z, param } from '../middleware/common.js';
import type { TaskRow, RoomRow } from '../core/mappers.js';
import { castVote, forceResolve, listProposals, sweepExpiredProposals } from '../core/consensus.js';
import { broadcastTaskUpdate, listTasks } from '../core/tasks.js';
import { roomMember, agentInRoom } from '../core/guards.js';
import type { ChatContext } from '../core/chat.js';

export function collabRouter(ctx: ChatContext): Router {
  const router = Router();

  router.get('/rooms/:id/proposals', requireUser, (req, res) => {
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    const db = dbOf(req);
    const roomId = param(req, 'id');
    roomMember(db, roomId, p.userId);
    res.json({ proposals: listProposals(db, roomId) });
  });

  router.get('/rooms/:id/tasks', (req, res) => {
    const db = dbOf(req);
    const p = req.principal;
    const roomId = param(req, 'id');
    if (p?.kind === 'user') {
      roomMember(db, roomId, p.userId);
    } else if (p?.kind === 'agent') {
      if (!agentInRoom(db, roomId, p.agentId)) throw forbidden('智能体不在该房间');
    } else {
      throw unauthorized();
    }
    res.json({ tasks: listTasks(db, roomId) });
  });

  /** 智能体投票（共识） */
  router.post('/proposals/:id/vote', requireAgent, async (req, res) => {
    const input = validated(req, VoteInput);
    const p = req.principal;
    if (p?.kind !== 'agent') throw forbidden();
    const proposal = castVote(
      ctx,
      input.proposalId,
      { type: 'agent', id: p.agentId, name: p.agent.name },
      input.choice,
      input.comment,
      req.ip,
    );
    res.json({ proposal });
  });

  /** 房主强制判定（人类兜底） */
  router.post('/proposals/:id/resolve', requireUser, async (req, res) => {
    const input = validated(req, ResolveProposalInput);
    const p = req.principal;
    if (p?.kind !== 'user') throw forbidden();
    if (input.decision === 'expired') throw forbidden('过期状态由系统判定');
    const proposal = forceResolve(ctx, param(req, 'id'), p.userId, p.user.display_name, input.decision);
    res.json({ proposal });
  });

  /** 任务状态更新（成员用户或负责智能体） */
  router.patch('/tasks/:id', async (req, res) => {
    const body = validated(req, z.object({ status: z.enum(['pending', 'in_progress', 'done', 'cancelled']) }));
    const db = dbOf(req);
    const p = req.principal;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(param(req, 'id')) as
      | (TaskRow & { room_id: string })
      | undefined;
    if (!task) throw notFound('任务不存在');
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(task.room_id) as unknown as RoomRow;

    if (p?.kind === 'user') {
      roomMember(db, room.id, p.userId);
    } else if (p?.kind === 'agent') {
      if (!agentInRoom(db, room.id, p.agentId) && task.assignee_agent_id !== p.agentId) throw forbidden('无权更新该任务');
    } else {
      throw unauthorized();
    }

    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(body.status, Date.now(), task.id);
    broadcastTaskUpdate(ctx, room.id, task.id);
    if (p.kind === 'user' || p.kind === 'agent') {
      audit(db, p.kind, p.kind === 'user' ? p.userId : p.agentId, 'task.update', { task: task.id, status: body.status }, req.ip);
    }
    res.json({ task: listTasks(db, room.id).find((t) => t.id === task.id) ?? null });
  });

  /** 手动触发超时清扫（运维/测试用，登录用户即可） */
  router.post('/proposals/sweep', requireUser, (req, res) => {
    res.json({ swept: sweepExpiredProposals(ctx) });
  });

  return router;
}
