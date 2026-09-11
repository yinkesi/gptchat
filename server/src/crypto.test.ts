import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, hashToken, newAgentToken, newId, newPairCode, safeEqualHex } from './crypto.js';
import { encryptJson, decryptJson } from './util/crypt.js';

test('密码散列：可验证、错误密码拒绝', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong password', h), false);
});

test('密码散列：同密码不同盐', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
});

test('密码散列：损坏格式安全返回 false', async () => {
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'scrypt$abc$def'), false);
});

test('令牌散列：确定性、不泄露原文', () => {
  const t = newAgentToken();
  assert.ok(t.startsWith('gptc_'));
  const h1 = hashToken(t);
  const h2 = hashToken(t);
  assert.equal(h1, h2);
  assert.ok(!h1.includes(t));
  assert.equal(safeEqualHex(h1, h2), true);
});

test('ID/配对码格式', () => {
  assert.ok(/^user_[a-z0-9]{12}$/.test(newId('user')));
  assert.ok(/^[A-HJ-KM-NP-Z2-9]{6}$/.test(newPairCode()));
});

test('授权数据 AES-GCM 加密往返', () => {
  const grants = [{ name: 'A', adapter: 'claude', agentToken: 'gptc_secret', agentId: 'agent_x' }];
  const blob = encryptJson(grants);
  assert.ok(!blob.includes('gptc_secret'), '密文不含明文令牌');
  const round = decryptJson<typeof grants>(blob);
  assert.deepEqual(round, grants);
});

test('授权数据：篡改密文解密失败返回 null', () => {
  const blob = encryptJson([{ k: 1 }]);
  const tampered = blob.slice(0, -4) + 'AAAA';
  assert.equal(decryptJson(tampered), null);
  assert.equal(decryptJson('not-a-blob'), null);
});
