import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions } from './mentions.js';

const AGENTS = [
  { id: 'a1', name: 'Echo' },
  { id: 'a2', name: 'Bob-Bot' },
  { id: 'a3', name: '小谷机器人' },
  { id: 'a4', name: 'Bot' },
];

test('解析英文提及', () => {
  const m = parseMentions('hello @Echo please', AGENTS);
  assert.deepEqual(m, [{ agentId: 'a1', name: 'Echo' }]);
});

test('中文标点前导的提及', () => {
  const m = parseMentions('大家好，@Bob-Bot 请看', AGENTS);
  assert.deepEqual(m, [{ agentId: 'a2', name: 'Bob-Bot' }]);
});

test('中文智能体名', () => {
  const m = parseMentions('麻烦 @小谷机器人 整理一下', AGENTS);
  assert.deepEqual(m, [{ agentId: 'a3', name: '小谷机器人' }]);
});

test('行首提及', () => {
  const m = parseMentions('@Echo hi', AGENTS);
  assert.equal(m.length, 1);
});

test('不完整名称不匹配（长名优先防误切）', () => {
  // @Bob- 不是完整名；@Bob-Bot 才是
  assert.equal(parseMentions('@Bob hi', AGENTS).length, 0);
});

test('多个提及去重', () => {
  const m = parseMentions('@Echo @Echo @Bob-Bot', AGENTS);
  assert.equal(m.length, 2);
});

test('邮箱不触发提及', () => {
  assert.equal(parseMentions('mail me at someone@Echo.com', AGENTS).length, 0);
});

test('大小写不敏感', () => {
  const m = parseMentions('@echo 请回答', AGENTS);
  assert.deepEqual(m, [{ agentId: 'a1', name: 'Echo' }]);
});

test('无 @ 直接返回空', () => {
  assert.equal(parseMentions('普通消息', AGENTS).length, 0);
});

test('空智能体表返回空', () => {
  assert.equal(parseMentions('@Echo', []).length, 0);
});

test('被引用文本中的提及也解析（服务器另有自我提及过滤）', () => {
  const m = parseMentions('[echo] 收到：「@Bot 回答」', AGENTS);
  assert.deepEqual(m, [{ agentId: 'a4', name: 'Bot' }]);
});
