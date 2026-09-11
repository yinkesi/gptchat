import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tally } from './consensus.js';
import { RoomFlow } from './flow.js';

test('共识计票：2 人 0.5 需 1 票', () => {
  assert.equal(tally(2, 1, 0, 0.5), 'accepted');
  assert.equal(tally(2, 0, 0, 0.5), 'open');
});

test('共识计票：3 人 0.5 需 2 票', () => {
  assert.equal(tally(3, 1, 0, 0.5), 'open');
  assert.equal(tally(3, 2, 0, 0.5), 'accepted');
});

test('共识计票：数学上不可能通过时立即否决', () => {
  // 5 人需 3 赞成；2 反对 → 最多 3 赞成？reject=3 时不可能 → rejected
  assert.equal(tally(5, 0, 3, 0.5), 'rejected');
  assert.equal(tally(5, 1, 2, 0.5), 'open'); // 还有 2 票未投，仍可能 3 赞成
  assert.equal(tally(5, 1, 3, 0.5), 'rejected');
});

test('共识计票：全体同意模式', () => {
  assert.equal(tally(3, 2, 0, 1), 'open');
  assert.equal(tally(3, 3, 0, 1), 'accepted');
  assert.equal(tally(3, 2, 1, 1), 'rejected');
});

test('共识计票：无人投票保持 open', () => {
  assert.equal(tally(3, 0, 0, 0.5), 'open');
});

// ---------- 流控 ----------

test('流控：智能体冷却按 agent 维度', () => {
  const f = new RoomFlow();
  assert.equal(f.agentCooldownRemaining('r1', 'a1'), 0);
  f.onAgentMessage('r1', 'a1', 8);
  assert.ok(f.agentCooldownRemaining('r1', 'a1') > 0);
  assert.equal(f.agentCooldownRemaining('r1', 'a2'), 0); // 别的智能体不受影响
});

test('流控：连续发言达到上限后锁定，用户发言解锁', () => {
  const f = new RoomFlow();
  for (let i = 0; i < 8; i++) f.onAgentMessage('r1', 'a1', 8);
  assert.equal(f.isLocked('r1'), true);
  const was = f.onHumanMessage('r1');
  assert.equal(was, true);
  assert.equal(f.isLocked('r1'), false);
});

test('流控：不同房间互不影响', () => {
  const f = new RoomFlow();
  f.onAgentMessage('r1', 'a1', 8);
  assert.equal(f.isLocked('r2'), false);
});
