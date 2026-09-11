import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

/**
 * bridge 本地状态：~/.gptchat/bridge.json
 * 仅存本机自愿提供的信息（服务器地址、配对所得令牌、本地命令模板）。
 * 文件权限尽力收紧为 0600。
 */
export interface AdapterConfig {
  /** 适配器标识（唯一名） */
  adapter: string;
  /** 本地命令模板，如 ["claude", "-p", "{prompt}"]；占位符 {prompt} 会被替换 */
  command: string[];
  /** 可选：显示名 */
  name?: string;
}

export interface BridgeState {
  server: string;
  deviceToken?: string;
  deviceId?: string;
  machineName: string;
  /** agentId -> { name, token, adapter }（配对批准后获得） */
  agents: Record<string, { name: string; token: string; adapter: string }>;
  /** 用户自定义本地命令模板 */
  customAdapters?: AdapterConfig[];
}

export function configFile(): string {
  // 测试/多实例场景可用环境变量覆盖
  return process.env.GPTCHAT_BRIDGE_CONFIG ?? path.join(homedir(), '.gptchat', 'bridge.json');
}

export function loadState(): BridgeState | null {
  const f = configFile();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as BridgeState;
  } catch {
    return null;
  }
}

export function saveState(state: BridgeState): void {
  const f = configFile();
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function updateState(patch: Partial<BridgeState>): BridgeState {
  const state = { ...(loadState() ?? { server: '', machineName: hostname() }), ...patch };
  saveState(state as BridgeState);
  return state as BridgeState;
}
