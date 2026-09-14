/**
 * WebSocket 网关集成测试：真实 HTTP/WS 栈。
 * 覆盖：鉴权、实时投递、ack、离线补发（backlog）、presence 上下线广播。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

process.env.JWT_SECRET = 'test-secret-0123456789-0123456789-abc';
process.env.DB_PATH = path.join(tmpdir(), `gptchat-wstest-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';

const { createApp } = await import('./app.js');
const { Hub, Presence } = await import('./core/hub.js');
const { RoomFlow } = await import('./core/flow.js');
const { getDb, closeDb } = await import('./db.js');
const { setupGateway } = await import('./net/gateway.js');
const { signSessionJwt } = await import('./middleware/auth.js');

type S2C = Record<string, unknown>;

const db = getDb();
const hub = new Hub(db);
const presence = new Presence(db, hub);
const flow = new RoomFlow();
const ctx = { db, hub, presence, flow } as const;
const app = createApp(ctx as never);
const server = createServer(app);
const wss = setupGateway(server, hub, presence);

let port = 0;

before(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
    server.close();
  });
  closeDb();
});

// ---------- HTTP 辅助 ----------
let userToken = '';
let userCookie = '';
let agentToken = '';
let roomId = '';
const agentIdHolder: { id: string } = { id: '' };

async function http(method: string, p: string, body?: unknown, auth?: string): Promise<{ status: number; data: any; setCookie?: string[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-gptchat-native': '1',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie?.();
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie };
}

/** 收集 WS 事件直到匹配 */
function collect(sock: WebSocket, timeoutMs = 3000): Promise<S2C[]> {
  const events: S2C[] = [];
  return new Promise((resolve) => {
    const onMsg = (raw: unknown): void => {
      events.push(JSON.parse(String(raw)));
    };
    sock.on('message', onMsg);
    setTimeout(() => {
      sock.off('message', onMsg);
      resolve(events);
    }, timeoutMs);
  });
}

interface RecWS extends WebSocket {
  seen: S2C[];
}

/** 连接并从「创建那一刻」记录所有入站事件（backlog 在 open 前后立即到达，不能事后才挂监听）。 */
function connectWs(auth: string): Promise<RecWS> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: auth.startsWith('gptc_')
        ? { authorization: `Bearer ${auth}` }
        : { authorization: `Bearer ${auth}`, cookie: userCookie },
    }) as RecWS;
    ws.seen = [];
    ws.on('message', (raw) => {
      try {
        ws.seen.push(JSON.parse(String(raw)));
      } catch {
        /* 忽略非 JSON */
      }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('准备：注册用户、创建智能体与房间', async () => {
  const r = await http('POST', '/auth/register', { username: `wsuser_${Date.now() % 100000}`, password: 'password123' });
  assert.equal(r.status, 201);
  userToken = r.data.token;
  userCookie = (r.setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
  assert.ok(userCookie.includes('gptchat_session'));

  const a = await http('POST', '/my/agents', { name: 'WsBot', kind: 'api', adapter: 'generic' }, userToken);
  assert.equal(a.status, 201);
  agentToken = a.data.token;
  agentIdHolder.id = a.data.agent.id;

  const room = await http('POST', '/rooms', { name: 'ws测试房' }, userToken);
  roomId = room.data.room.id;
  const join = await http('POST', `/rooms/${roomId}/agents`, { agentId: agentIdHolder.id }, userToken);
  assert.equal(join.status, 201);
});

test('WS 鉴权失败：无凭据被拒', async () => {
  await assert.rejects(
    () =>
      new Promise<never>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => resolve(ws as never));
        ws.on('error', (e) => reject(e));
      }),
    () => true,
  );
});

test('WS 鉴权成功（智能体令牌 + 用户会话），收到 hello', async () => {
  const agentWs = await connectWs(agentToken);
  assert.ok(agentWs.seen.some((e) => e.type === 'hello' && (e.agentIds as string[]).includes(agentIdHolder.id)));
  agentWs.close();

  const userWs = await connectWs(userToken);
  assert.ok(userWs.seen.some((e) => e.type === 'hello' && typeof e.userId === 'string'));
  userWs.close();
  await sleep(200);
});

test('实时投递：@提及即时到达在线智能体；用户同时收到消息广播', async () => {
  const agentWs = await connectWs(agentToken);
  const userWs = await connectWs(userToken);
  userWs.send(JSON.stringify({ type: 'room.join', roomId }));
  await sleep(300);

  const sent = await http('POST', `/rooms/${roomId}/messages`, { body: '@WsBot 你在吗' }, userToken);
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.mentions.length, 1);
  await sleep(700);

  const mention = agentWs.seen.find((e) => e.type === 'agent.mention');
  assert.ok(mention, '智能体应收到 agent.mention');
  assert.equal(mention!.agentId, agentIdHolder.id);
  assert.ok((mention!.inboxId as number) > 0);
  assert.ok((mention!.body as string).includes('你在吗'));

  assert.ok(userWs.seen.some((e) => e.type === 'message.new' && (e.message as { body: string }).body.includes('你在吗')));

  // ack 后不再补发
  agentWs.send(JSON.stringify({ type: 'inbox.ack', ids: [mention!.inboxId] }));
  await sleep(300);
  agentWs.close();
  userWs.close();
  await sleep(200);
});

test('离线补发：智能体离线时收到提及，重连后 backlog 补发', async () => {
  // 智能体此刻离线
  const sent = await http('POST', `/rooms/${roomId}/messages`, { body: '离线消息：@WsBot 收到请回答' }, userToken);
  assert.equal(sent.status, 201);

  await sleep(300);
  const agentWs = await connectWs(agentToken);
  await sleep(700);
  const backlog = agentWs.seen.find((e) => e.type === 'agent.mention' && (e.body as string).includes('收到请回答'));
  assert.ok(backlog, '重连后应补发离线提及');
  agentWs.close();
  await sleep(200);
});

test('presence：智能体上线/下线广播给房间用户', async () => {
  const userWs = await connectWs(userToken);
  userWs.send(JSON.stringify({ type: 'room.join', roomId }));
  await sleep(300);

  const agentWs = await connectWs(agentToken);
  await sleep(500);
  agentWs.close();
  await sleep(700);
  assert.ok(
    userWs.seen.some(
      (e) => e.type === 'presence' && (e.agents as Array<{ status: string }>).some((a) => a.status === 'offline'),
    ),
    '应收到 offline presence',
  );
  userWs.close();
  await sleep(100);
});

test('非成员加入房间被拒', async () => {
  const r2 = await http('POST', '/auth/register', { username: `intruder_${Date.now() % 100000}`, password: 'password123' });
  const intruderWs = await connectWs(r2.data.token);
  intruderWs.send(JSON.stringify({ type: 'room.join', roomId }));
  await sleep(600);
  assert.ok(intruderWs.seen.some((e) => e.type === 'error' && e.code === 'FORBIDDEN'));
  intruderWs.close();
  await sleep(100);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
