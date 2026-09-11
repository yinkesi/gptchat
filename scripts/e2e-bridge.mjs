#!/usr/bin/env node
/**
 * bridge 端到端测试：真实服务器 + 真实 bridge runtime + 假 CLI。
 * 验证：设备配对批准 → bridge WS 上线 → @提及 → 本地 CLI 被调用 → 回帖落库 → ack。
 * 前置：服务器已在运行（默认 http://127.0.0.1:8791，需先 npm run build -w bridge）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const base = process.argv[2] ?? 'http://127.0.0.1:8791';
const tmp = mkdtempSync(path.join(tmpdir(), 'gptchat-bridge-'));
process.env.GPTCHAT_BRIDGE_CONFIG = path.join(tmp, 'bridge.json');

const { runRuntime } = await import('../bridge/dist/runtime.js');
const { saveState } = await import('../bridge/dist/config.js');

const API = (p) => `${base}/api/v1${p}`;
let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, body, token) {
  const res = await fetch(API(p), {
    method,
    headers: {
      'content-type': 'application/json',
      'x-gptchat-native': '1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// 1. 人类用户
const uniq = Date.now().toString(36);
let r = await req('POST', '/auth/register', { username: `owner_${uniq}`, password: 'password123' });
const userToken = r.data.token;
ok('注册用户', r.status === 201);

// 2. bridge 发起配对（候选 = 自定义 fake 适配器）
r = await req('POST', '/pairing/requests', {
  pairCode: 'BRIDGE',
  machineName: '测试机',
  platform: 'test',
  candidates: [{ name: 'Fake-CLI', adapter: 'fake' }],
});
const requestId = r.data.requestId;
ok('bridge 发起配对', r.status === 201 && requestId);

// 3. 用户认领 + 批准
r = await req('POST', '/my/devices/claim', { pairCode: 'BRIDGE' }, userToken);
ok('用户认领', r.status === 200);
r = await req('POST', `/my/devices/${requestId}/approve`, { candidates: [{ name: 'Fake-CLI', approved: true }] }, userToken);
ok('用户批准', r.status === 200);
r = await req('GET', `/pairing/requests/${requestId}`);
const grant = r.data.grants?.[0];
const deviceToken = r.data.deviceToken;
ok('bridge 领取 deviceToken + grant', !!grant?.agentToken && !!deviceToken);

// 4. 建房间 + 拉入配对智能体
r = await req('POST', '/rooms', { name: '桥接测试房' }, userToken);
const roomId = r.data.room.id;
r = await req('POST', `/rooms/${roomId}/agents`, { agentId: grant.agentId }, userToken);
ok('配对智能体加入房间', r.status === 201);

// 5. 假 CLI 脚本（被 spawn 的"本地智能体"）
const fakeScript = path.join(tmp, 'fake-agent.mjs');
writeFileSync(
  fakeScript,
  "console.log('[fake-agent] 收到提示词 ' + process.argv[2].length + ' 字符，这是模拟 CLI 的回复。');\n",
);

// 6. bridge runtime 上线
saveState({
  server: base,
  deviceToken,
  machineName: '测试机',
  agents: {
    [grant.agentId]: { name: grant.name, token: grant.agentToken, adapter: 'fake' },
  },
  customAdapters: [{ adapter: 'fake', command: ['node', fakeScript, '{prompt}'] }],
});
console.log('  启动 bridge runtime（WS）…');
runRuntime({
  server: base,
  deviceToken,
  agents: { [grant.agentId]: { name: grant.name, token: grant.agentToken, adapter: 'fake' } },
  customAdapters: [{ adapter: 'fake', command: ['node', fakeScript, '{prompt}'] }],
  log: (m) => console.log(`  [bridge] ${m}`),
});
await sleep(1200);

// 7. 用户 @提及 Fake-CLI
r = await req('POST', `/rooms/${roomId}/messages`, { body: '@Fake-CLI 请报告你的状态' }, userToken);
ok('发送提及', r.status === 201 && r.data.message.mentions.length === 1);
await sleep(2500);

r = await req('GET', `/rooms/${roomId}/messages`, undefined, userToken);
const reply = r.data.messages.find((m) => m.senderType === 'agent' && m.body.includes('fake-agent'));
ok('假 CLI 的回复已入房间', !!reply, JSON.stringify(r.data.messages.map((m) => m.body.slice(0, 30))));
ok('回复确由配对智能体发出', reply?.senderName === 'Fake-CLI');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
