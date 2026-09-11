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
const hub = new Hub();
const presence = new Presence(db, hub);
const flow = new RoomFlow();
const ctx: ChatContext = { db, hub, presence, flow };

const app = createApp(ctx);
const server = createServer(app);
const wss = setupGateway(server, hub, presence, flow);

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

// ---------- 优雅退出 ----------
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down…`);
  sweeper.unref();
  server.close(() => {
    wss.close();
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
