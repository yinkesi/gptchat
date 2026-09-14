import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb, closeDb } from './db.js';
import { createApp } from './app.js';
import { Hub, Presence } from './core/hub.js';
import { RoomFlow } from './core/flow.js';
import { setupGateway } from './net/gateway.js';
import { sweepExpiredProposals } from './core/consensus.js';
import type { ChatContext } from './core/chat.js';

const log = (...args: unknown[]): void => console.log('[gptchat]', ...args);

const db = getDb();
const hub = new Hub(db);
const presence = new Presence(db, hub);
const flow = new RoomFlow();
const ctx: ChatContext = { db, hub, presence, flow };

const app = createApp(ctx);
const server = createServer(app);
const wss = setupGateway(server, hub, presence);

// 提案超时清扫：每 30s，幂等
const sweeper = setInterval(() => {
  try {
    sweepExpiredProposals(ctx);
  } catch (err) {
    console.error('[sweeper]', err);
  }
}, 30_000);
sweeper.unref();

server.listen(config.port, config.host, () => {
  log(`server listening on http://${config.host}:${config.port}`);
  log(`env=${config.isProd ? 'production' : 'development'} db=${config.dbPath}`);
});

// ---------- 保洁员：长期运行防数据/内存积累 ----------
const janitor = setInterval(() => {
  try {
    const day = 24 * 60 * 60 * 1000;
    // 过期配对请求（过期超 1 天才删，留足排查窗口）
    db.prepare("DELETE FROM devices WHERE status = 'pending' AND expires_at < ?").run(Date.now() - day);
    // 已投递且超过 7 天的收件箱（未投递的永不删，保证至少一次投递）
    db.prepare('DELETE FROM inbox WHERE delivered = 1 AND created_at < ?').run(Date.now() - 7 * day);
    // 房间内存流控状态的陈旧条目
    flow.pruneStale();
  } catch (err) {
    console.error('[janitor]', err);
  }
}, 5 * 60_000);
janitor.unref();

// ---------- 优雅退出 ----------
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down…`);
  sweeper.unref();
  janitor.unref();
  // 先关 WebSocket（向客户端发起关闭握手），否则 WS 长连接会拖住 server.close
  try {
    wss.close();
  } catch {
    /* 已关闭 */
  }
  server.close(() => {
    closeDb();
    log('bye');
    process.exit(0);
  });
  // 兜底：5s 后强退
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
