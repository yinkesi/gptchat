import WebSocket from 'ws';
import { buildPrompt, invokeAdapter } from './adapters.js';
import { postMessage } from './http.js';
import type { BridgeState } from './config.js';

export interface RuntimeOptions {
  server: string;
  deviceToken: string;
  /** agentId -> { name, token, adapter }（配对所得） */
  agents: Record<string, { name: string; token: string; adapter: string }>;
  customAdapters: Array<{ adapter: string; command: string[]; name?: string }>;
  log: (msg: string) => void;
}

interface MentionEvent {
  type: 'agent.mention';
  inboxId: number;
  agentId: string;
  roomId: string;
  messageId: number;
  from: string;
  body: string;
}

/**
 * bridge 运行时：以设备身份维持 WebSocket；
 * agent.mention(agentId) → 调用本地 CLI → 该智能体令牌回帖 → ack。
 * 断线指数退避重连；重连后服务器补发未 ack 提及（at-least-once，按 inboxId 幂等）。
 */
export function runRuntime(opts: RuntimeOptions): void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let closedByUser = false;
  const contextByRoom = new Map<string, string[]>();
  const busyAgents = new Set<string>();

  function connect(): void {
    const proto = opts.server.startsWith('https') ? 'wss' : 'ws';
    const host = opts.server.replace(/^https?:\/\//, '').replace(/\/$/, '');
    ws = new WebSocket(`${proto}://${host}/ws`, {
      headers: { authorization: `Bearer ${opts.deviceToken}` },
      maxPayload: 64 * 1024,
    });
    ws.on('open', () => {
      retry = 0;
      const names = Object.values(opts.agents).map((a) => a.name).join(', ');
      opts.log(`已连接。在席智能体: ${names || '（无）'}`);
    });
    ws.on('message', (raw) => void onMessage(String(raw)));
    ws.on('close', () => {
      if (closedByUser) return;
      const delay = Math.min(15000, 800 * 2 ** retry++);
      opts.log(`连接断开，${Math.round(delay / 1000)}s 后重连…`);
      setTimeout(connect, delay);
    });
    ws.on('error', (err) => opts.log(`连接错误: ${err.message}`));
  }

  async function onMessage(raw: string): Promise<void> {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (ev.type === 'message.new') {
      const m = ev.message as { roomId: string; senderName: string; senderType: string; body: string };
      if (m.senderType !== 'system') {
        const arr = contextByRoom.get(m.roomId) ?? [];
        arr.push(`${m.senderName}: ${m.body.slice(0, 300)}`);
        if (arr.length > 10) arr.shift();
        contextByRoom.set(m.roomId, arr);
      }
      return;
    }
    if (ev.type === 'agent.mention') {
      await handleMention(ev as unknown as MentionEvent);
    }
  }

  async function handleMention(ev: MentionEvent): Promise<void> {
    const target = opts.agents[ev.agentId];
    if (!target) {
      ack([ev.inboxId]);
      return;
    }
    if (busyAgents.has(ev.agentId)) {
      // 串行保护：同一智能体一次处理一个提及；不 ack，稍后由服务器补投
      return;
    }
    busyAgents.add(ev.agentId);
    try {
      opts.log(`@${target.name} 收到 ${ev.from} 的提及，调用本地 CLI…`);
      const result = await invokeAdapter(
        target.adapter,
        buildPrompt({
          room: ev.roomId,
          from: ev.from,
          body: ev.body,
          context: contextByRoom.get(ev.roomId) ?? [],
        }),
        opts.customAdapters,
      );
      const reply = (result.ok ? result.text : `[bridge] ${result.text}`).slice(0, 15000);
      let res = await postMessage(opts.server, ev.roomId, reply, target.token);
      if (res.status === 429) {
        await sleep(2500);
        res = await postMessage(opts.server, ev.roomId, reply, target.token);
      }
      if (res.status >= 500) {
        // 服务器瞬时故障：退避后重试一次；仍失败则保留未 ack，由重连补投兜底
        await sleep(2000);
        res = await postMessage(opts.server, ev.roomId, reply, target.token);
      }
      if (res.ok) {
        opts.log(`${target.name} 已回复`);
        ack([ev.inboxId]);
      } else {
        opts.log(`回复失败（HTTP ${res.status}），保留未 ack 以便重投`);
      }
    } catch (err) {
      opts.log(`处理提及出错: ${String(err).slice(0, 200)}`);
    } finally {
      busyAgents.delete(ev.agentId);
    }
  }

  function ack(ids: number[]): void {
    ws?.send(JSON.stringify({ type: 'inbox.ack', ids }));
  }

  connect();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
