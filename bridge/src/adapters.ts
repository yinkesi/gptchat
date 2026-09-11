import { spawn } from 'node:child_process';
import { BUILTIN_ADAPTERS } from './discover.js';
import type { AdapterConfig } from './config.js';

export interface InvokeResult {
  ok: boolean;
  text: string;
}

const TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 8000;

/**
 * 调用本地 CLI 智能体。
 * 安全边界：
 *  - 一律 spawn argv 数组，绝不经过 shell —— 用户消息内容不会被解释为命令；
 *  - 命令模板只来自本地配置（内置表或 ~/.gptchat/bridge.json），服务器无法远程下发命令；
 *  - 超时 + 输出截断，防止挂死与刷屏。
 * 提示词按「不可信数据」处理：只作为最后一个参数传入，不拼进任何命令。
 */
export function buildPrompt(args: { room: string; from: string; body: string; context: string[] }): string {
  const ctx = args.context.length
    ? `\n\n[最近的群聊记录]\n${args.context.slice(-8).join('\n')}`
    : '';
  return [
    `你在群聊「${args.room}」中被 @ 提及。`,
    `${args.from} 说：`,
    `"""`,
    args.body,
    `"""`,
    ctx,
    `请直接给出你的回复正文（纯文本，将原样发回群聊）。不要输出与回复无关的内容。`,
  ].join('\n');
}

export function invokeAdapter(
  adapter: string,
  prompt: string,
  custom: AdapterConfig[] = [],
): Promise<InvokeResult> {
  let argv: string[] | null = null;
  const customHit = custom.find((c) => c.adapter === adapter);
  if (customHit) {
    argv = customHit.command.map((seg) => seg.replace('{prompt}', prompt));
  } else if (BUILTIN_ADAPTERS[adapter]) {
    argv = BUILTIN_ADAPTERS[adapter]!.map((seg) => seg.replace('{prompt}', prompt));
  } else if (adapter === 'echo') {
    return Promise.resolve({ ok: true, text: `[echo] ${prompt.slice(0, 200)}` });
  }
  if (!argv) {
    return Promise.resolve({ ok: false, text: `没有找到适配器「${adapter}」的本地命令配置` });
  }

  const bin = argv[0]!;
  const args = argv.slice(1);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ ok: false, text: `无法启动 ${bin}: ${String(err).slice(0, 200)}` });
      return;
    }
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill('SIGKILL');
        resolve({ ok: false, text: `适配器 ${adapter} 执行超时（${TIMEOUT_MS / 1000}s）` });
      }
    }, TIMEOUT_MS);

    const collect = (chunk: Buffer): void => {
      if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, text: `无法启动 ${bin}（未安装或不在 PATH）: ${err.message.slice(0, 160)}` });
      }
    });
    child.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        const text = out.trim().slice(0, MAX_OUTPUT);
        if (code === 0 && text) resolve({ ok: true, text });
        else if (text) resolve({ ok: true, text }); // 部分 CLI 用非零码返回但仍有有效输出
        else resolve({ ok: false, text: `适配器 ${adapter} 退出码 ${code}，无输出` });
      }
    });
  });
}
