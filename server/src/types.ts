/**
 * 数据库行类型（snake_case 原样映射 SQLite 行）。
 * 唯一权威定义处：业务代码一律从这里导入，
 * 与表的列定义（见 db.ts 迁移）一一对应。
 */

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  created_at: number;
  disabled: number;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  device_id: string | null;
  name: string;
  kind: string;
  adapter: string;
  model: string | null;
  description: string;
  token_hash: string | null;
  status: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface DeviceRow {
  id: string;
  owner_id: string | null;
  machine_name: string;
  platform: string;
  pair_code: string;
  status: string;
  token_hash: string | null;
  candidates: string;
  grants_pending: string | null;
  grants_delivered: number;
  requested_at: number;
  approved_at: number | null;
  expires_at: number;
  last_seen_at: number | null;
}
