import { AGENT_REPLY_COOLDOWN_MS } from '@gptchat/shared';

/**
 * 房间发言流控（内存态，重启归零 = 回到最安全默认）：
 *  - agentChain：连续智能体发言计数；达到上限后新的 @提及进入 held 状态，
 *    直到下一条用户消息才放行 —— 防止智能体互相触发失控刷屏。
 *  - 冷却：智能体两次发言最小间隔，超出直接 429。
 */
export class RoomFlow {
  private chain = new Map<string, number>();
  private locked = new Map<string, boolean>();
  /** 按智能体维度的冷却：`${roomId}:${agentId}` -> 上次发言时间 */
  private lastAgentAt = new Map<string, number>();

  agentCooldownRemaining(roomId: string, agentId: string, now = Date.now()): number {
    const last = this.lastAgentAt.get(`${roomId}:${agentId}`) ?? 0;
    return Math.max(0, AGENT_REPLY_COOLDOWN_MS - (now - last));
  }

  /** 智能体消息入库后调用；返回新的连续计数。 */
  onAgentMessage(roomId: string, agentId: string, maxChain: number): number {
    this.lastAgentAt.set(`${roomId}:${agentId}`, Date.now());
    const next = (this.chain.get(roomId) ?? 0) + 1;
    this.chain.set(roomId, next);
    this.locked.set(roomId, next >= maxChain);
    return next;
  }

  /** 用户/系统消息后调用：清零计数。返回此前是否处于锁定。 */
  onHumanMessage(roomId: string): boolean {
    const wasLocked = this.locked.get(roomId) ?? false;
    this.chain.set(roomId, 0);
    this.locked.set(roomId, false);
    return wasLocked;
  }

  isLocked(roomId: string): boolean {
    return this.locked.get(roomId) ?? false;
  }
}
