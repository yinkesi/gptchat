import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

/**
 * 存储层：SQLite（node:sqlite，零原生依赖）。
 * 全部查询走参数化预处理语句，杜绝 SQL 注入。
 * 存储通过这一层隔离，未来可替换为 Postgres 驱动而不影响业务代码。
 */

export type DB = DatabaseSync;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/** 测试专用：内存数据库 */
export function openTestDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  migrate(d);
  return d;
}

let migrationStatements: readonly string[] | null = null;

function schemaV1(): string[] {
  return [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      settings TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE room_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    )`,
    `CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      machine_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      pair_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      token_hash TEXT,
      candidates TEXT NOT NULL DEFAULT '[]',
      grants_pending TEXT,
      grants_delivered INTEGER NOT NULL DEFAULT 0,
      requested_at INTEGER NOT NULL,
      approved_at INTEGER,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )`,
    `CREATE INDEX idx_devices_paircode ON devices(pair_code, status)`,
    `CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      adapter TEXT NOT NULL,
      model TEXT,
      description TEXT NOT NULL DEFAULT '',
      token_hash TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'offline',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )`,
    `CREATE INDEX idx_agents_owner ON agents(owner_id)`,
    `CREATE TABLE agent_rooms (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, room_id)
    )`,
    `CREATE INDEX idx_agent_rooms_room ON agent_rooms(room_id)`,
    `CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      proposal_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_messages_room ON messages(room_id, seq)`,
    `CREATE TABLE proposals (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      tasks_spec TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      author_type TEXT NOT NULL,
      author_id TEXT,
      author_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolve_by INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_proposals_room ON proposals(room_id, status)`,
    `CREATE TABLE votes (
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      voter_type TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      voter_name TEXT NOT NULL,
      choice TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (proposal_id, voter_type, voter_id)
    )`,
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      proposal_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_by_type TEXT NOT NULL,
      created_by_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_tasks_room ON tasks(room_id, status)`,
    `CREATE TABLE inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      message_seq INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'mention',
      delivered INTEGER NOT NULL DEFAULT 0,
      held INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_inbox_agent ON inbox(agent_id, delivered)`,
    `CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      event TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      ip TEXT
    )`,
  ];
}

function migrate(d: DatabaseSync): void {
  if (!migrationStatements) migrationStatements = schemaV1();
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = d.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  const versions: Array<[number, () => string[]]> = [[1, schemaV1]];
  for (const [version, makeStatements] of versions) {
    if (version <= current) continue;
    const statements = makeStatements();
    d.exec('BEGIN');
    try {
      for (const stmt of statements) d.exec(stmt);
      d.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
}

// ---------- 审计日志 ----------

export type ActorType = 'user' | 'agent' | 'device' | 'system' | 'anonymous';

export function audit(
  d: DatabaseSync,
  actorType: ActorType,
  actorId: string | null,
  event: string,
  meta: Record<string, unknown> = {},
  ip?: string,
): void {
  d.prepare(
    'INSERT INTO audit_log (ts, actor_type, actor_id, event, meta, ip) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(Date.now(), actorType, actorId, event, JSON.stringify(meta), ip ?? null);
}
