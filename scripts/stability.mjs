#!/usr/bin/env node
/**
 * gptchat 稳定性验证：自行拉起服务器实例做破坏性测试，不污染业务数据。
 *
 * 覆盖：
 *  1) 压力浸泡 —— 多用户并发发消息，全部落库、无 5xx
 *  2) 事件洪泛 —— 单 WS 连接超速发包，被服务端断开且服务器保持健康
 *  3) 崩溃恢复 —— kill -9 后重启进程，消息数据不丢、接口恢复
 *  4) 重连恢复 —— 服务器重启后客户端重新连上并重新 hello
 *  5) 背压保护 —— 健康检查在洪泛后仍快速响应
 *
 * 用法：node scripts/stability.mjs [端口，默认 8793]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = Number(process.argv[2] ?? 8793);
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/v1`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'gptchat-stab-'));
const dbPath = path.join(dataDir, 'stab.db');

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

function startServer() {
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    env: {
      ...process.env,
      JWT_SECRET: 'stability-test-secret-0123456789-0123456789',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitHealthy(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  return false;
}

async function req(method, p, body, token) {
  const res = await fetch(`${API}${p}`, {
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

function connectWs(token, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: cookie
        ? { authorization: `Bearer ${token}`, cookie }
        : { authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function main() {
  console.log(`启动被测服务器 :${PORT}（临时库 ${path.basename(dbPath)}）`);
  let server = startServer();
  ok('服务器启动并健康', await waitHealthy());

  // ---------- 准备用户与房间 ----------
  const uniq = Date.now().toString(36);
  const users = [];
  const names = [];
  for (let i = 0; i < 3; i++) {
    const name = `stab_${uniq}_${i}`;
    const r = await req('POST', '/auth/register', { username: name, password: 'password123' });
    users.push(r.data.token);
    names.push(name);
  }
  const room = await req('POST', '/rooms', { name: '稳定性浸泡房' }, users[0]);
  const roomId = room.data.room.id;
  // 全部用户入房（否则消息会被 403）
  for (const name of names.slice(1)) {
    await req('POST', `/rooms/${roomId}/members`, { username: name }, users[0]);
  }

  // ---------- 1. 压力浸泡：3 用户 × 40 条并发消息 ----------
  console.log('— 压力浸泡 —');
  const t0 = Date.now();
  const PER_USER = 30; // 每用户限流 40/min，取 30 保证全部落库
  const results = await Promise.all(
    users.flatMap((token, ui) =>
      Array.from({ length: PER_USER }, (_, i) =>
        req('POST', `/rooms/${roomId}/messages`, { body: `压力消息 u${ui}#${i}` }, token),
      ),
    ),
  );
  const okCount = results.filter((r) => r.status === 201).length;
  const serverErrors = results.filter((r) => r.status >= 500).length;
  const ms = Date.now() - t0;
  ok(`并发 ${results.length} 条：全部 201（实际 ${okCount}），无 5xx（${serverErrors}），耗时 ${ms}ms`, serverErrors === 0 && okCount === results.length);
  const listed = await req('GET', `/rooms/${roomId}/messages?limit=100`, undefined, users[0]);
  ok(`落库零丢失（${listed.data.messages.length}/${results.length}）`, listed.data.messages.length === results.length);
  const health = await fetch(`${BASE}/healthz`);
  ok('浸泡后服务器健康', health.ok);

  // ---------- 2. 事件洪泛：单连接超速发包应被断开 ----------
  console.log('— 事件洪泛 —');
  const flood = await connectWs(users[0]);
  let floodClosed = false;
  flood.on('close', () => {
    floodClosed = true;
  });
  for (let i = 0; i < 60; i++) {
    try {
      flood.send(JSON.stringify({ type: 'typing', roomId }));
    } catch {
      break;
    }
  }
  await sleep(1500);
  ok('超速连接被服务端关闭（限速 20 事件/10s）', floodClosed);
  const t1 = Date.now();
  const h2 = await fetch(`${BASE}/healthz`);
  ok(`洪泛后健康检查正常（${Date.now() - t1}ms）`, h2.ok && Date.now() - t1 < 1000);

  // ---------- 3. 崩溃恢复：kill -9 后数据不丢 ----------
  console.log('— 崩溃恢复 —');
  const before = await req('GET', `/rooms/${roomId}/messages?limit=100`, undefined, users[0]);
  const countBefore = before.data.messages.length;
  server.kill('SIGKILL');
  await sleep(600);
  ok('进程已被 kill -9', !server.exitCode && server.killed);
  server = startServer();
  ok('重启后健康', await waitHealthy());
  const after = await req('GET', `/rooms/${roomId}/messages?limit=100`, undefined, users[0]);
  ok(`消息不丢（重启前 ${countBefore} 条 = 重启后 ${after.data.messages.length} 条）`, after.data.messages.length === countBefore);
  const relogin = await req('POST', '/auth/login', { username: `stab_${uniq}_0`, password: 'password123' });
  ok('重启后登录正常', relogin.status === 200);

  // ---------- 4. 重连恢复 ----------
  console.log('— WS 重连 —');
  const ws2 = await connectWs(users[0]);
  const hello = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    ws2.on('message', (raw) => {
      const e = JSON.parse(String(raw));
      if (e.type === 'hello') {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });
  ok('重连收到 hello', !!hello);
  ws2.send(JSON.stringify({ type: 'room.join', roomId }));
  await sleep(300);

  // 重启服务器 → 客户端断开 → 服务器恢复 → 客户端重连成功
  server.kill('SIGKILL');
  await sleep(500);
  server = startServer();
  ok('再次重启后健康', await waitHealthy());
  const ws3 = await connectWs(users[0]);
  const hello3 = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    ws3.on('message', (raw) => {
      const e = JSON.parse(String(raw));
      if (e.type === 'hello') {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });
  ok('二次重启后客户端重连成功', !!hello3);
  ws2.terminate();
  ws3.close();

  // ---------- 5. 收尾 ----------
  try {
    ws2.terminate();
  } catch { /* noop */ }
  server.kill('SIGTERM');
  await sleep(400);
  rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('稳定性测试异常:', err);
  try {
    server.kill('SIGKILL');
  } catch { /* noop */ }
  process.exit(1);
});
