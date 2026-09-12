#!/usr/bin/env node
/**
 * gptchat 数据库备份脚本（跨平台，零依赖，不停服）。
 *
 * 原理：SQLite 的 VACUUM INTO 会在 WAL 并发写入时生成一致性快照，
 * 不需要停止服务器，也不需要 sqlite3 命令行工具。
 *
 * 用法：
 *   node scripts/backup.mjs                 # 备份到 ./backups/
 * 环境变量：
 *   DB_PATH      源数据库路径（默认 ./data/gptchat.db）
 *   BACKUP_DIR   备份目录（默认 ./backups）
 *   BACKUP_KEEP  保留份数（默认 14）
 *
 * 退出码：0 成功；1 失败（配合 cron/任务计划报警）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve('data/gptchat.db');
const backupDir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.resolve('backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));

function fail(msg) {
  console.error(`[backup] 失败: ${msg}`);
  process.exit(1);
}

if (!existsSync(dbPath)) fail(`源数据库不存在: ${dbPath}`);

// 1. 在线快照（VACUUM INTO 对源库只读，WAL 下可与写入并发）
const ts = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}${String(ts.getMilliseconds()).padStart(3, '0')}`;
mkdirSync(backupDir, { recursive: true });
const target = path.join(backupDir, `gptchat-${stamp}.db`);

const src = new DatabaseSync(dbPath);
try {
  src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} catch (err) {
  fail(`VACUUM INTO 失败: ${err.message}`);
} finally {
  src.close();
}

// 2. 校验备份可用：能打开、快速完整性检查通过、业务表可读
const check = new DatabaseSync(target);
try {
  const quick = check.prepare('PRAGMA quick_check').get();
  if (!quick || Object.values(quick)[0] !== 'ok') fail(`备份完整性检查未通过: ${JSON.stringify(quick)}`);
  const users = check.prepare('SELECT COUNT(*) AS n FROM users').get();
  const messages = check.prepare('SELECT COUNT(*) AS n FROM messages').get();
  var counts = `users=${users.n} messages=${messages.n}`;
} catch (err) {
  fail(`备份无法读取: ${err.message}`);
} finally {
  check.close();
}

// 3. 清理旧备份，只保留最近 keep 份
const files = readdirSync(backupDir)
  .filter((f) => /^gptchat-\d{8}-\d{6}-\d{3}\.db$/.test(f))
  .sort()
  .reverse();
for (const old of files.slice(keep)) {
  try {
    unlinkSync(path.join(backupDir, old));
  } catch {
    /* 被占用则下次再清 */
  }
}

const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(2);
console.log(
  `[backup] 成功: ${target}（${sizeMb} MB，${counts}），保留最近 ${keep} 份，共 ${Math.min(files.length, keep)} 份`,
);
