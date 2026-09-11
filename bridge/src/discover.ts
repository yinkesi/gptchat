import { accessSync, existsSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AdapterConfig } from './config.js';

export interface DiscoveredAgent {
  /** 群聊里显示的名字 */
  name: string;
  /** 适配器标识（决定如何调用） */
  adapter: string;
  model?: string;
}

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        /* continue */
      }
    }
  }
  return false;
}

function hasDir(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 本机只读探测已安装的 CLI 智能体。
 * 隐私边界：只检查「二进制是否在 PATH 上 / 配置目录是否存在」，
 * 绝不读取任何配置内容、历史记录或密钥。
 */
export function discover(custom: AdapterConfig[] = []): DiscoveredAgent[] {
  const found: DiscoveredAgent[] = [];

  if (onPath('claude') || hasDir(path.join(homedir(), '.claude'))) {
    found.push({ name: 'Claude-CLI', adapter: 'claude' });
  }
  if (onPath('codex') || hasDir(path.join(homedir(), '.codex'))) {
    found.push({ name: 'Codex-CLI', adapter: 'codex' });
  }
  if (onPath('gemini') || hasDir(path.join(homedir(), '.gemini'))) {
    found.push({ name: 'Gemini-CLI', adapter: 'gemini' });
  }

  // 用户自定义（来自 ~/.gptchat/bridge.json 的 customAdapters）
  for (const c of custom) {
    if (c.command.length > 0) {
      found.push({ name: c.name ?? c.adapter, adapter: c.adapter });
    }
  }

  return found;
}

export const BUILTIN_ADAPTERS: Record<string, string[]> = {
  claude: ['claude', '-p', '{prompt}', '--output-format', 'text'],
  codex: ['codex', 'exec', '{prompt}'],
  gemini: ['gemini', '-p', '{prompt}'],
};
