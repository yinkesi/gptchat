import { PairRequestInput } from '@gptchat/shared';
import type { DiscoveredAgent } from './discover.js';

const API = (server: string, p: string) => `${server.replace(/\/$/, '')}/api/v1${p}`;

function generatePairCode(): string {
  const set = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += set[Math.floor(Math.random() * set.length)];
  return out;
}

export interface PairingHandle {
  requestId: string;
  pairCode: string;
  /** 轮询直到批准/吊销/过期；resolve 于 approved。 */
  waitApproved(): Promise<{
    deviceToken: string;
    deviceId: string;
    grants: Array<{ name: string; adapter: string; agentId: string; agentToken: string }>;
  }>;
}

/** 发起配对（匿名端点，限流 12 次/小时/IP）。 */
export async function startPairing(
  server: string,
  machineName: string,
  agents: DiscoveredAgent[],
): Promise<PairingHandle> {
  const pairCode = generatePairCode();
  const body = PairRequestInput.parse({
    pairCode,
    machineName,
    platform: `${process.platform} · node ${process.version}`,
    candidates: agents.map((a) => ({ name: a.name, adapter: a.adapter, model: a.model })),
  });
  const res = await fetch(API(server, '/pairing/requests'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { requestId?: string; error?: { message: string } };
  if (!res.ok || !data.requestId) {
    throw new Error(data.error?.message ?? `配对请求失败（${res.status}）`);
  }
  const requestId: string = data.requestId;

  return {
    requestId,
    pairCode,
    async waitApproved() {
      // 最长等 10 分钟（服务器端 TTL），每 1.5s 轮询
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(1500);
        const r = await fetch(API(server, `/pairing/requests/${requestId}`));
        if (r.status === 410) throw new Error('配对请求已过期，请重新发起');
        const d = (await r.json()) as {
          status: 'pending' | 'approved' | 'revoked';
          deviceToken?: string;
          deviceId?: string;
          grants?: Array<{ name: string; adapter: string; agentId: string; agentToken: string }>;
        };
        if (d.status === 'approved' && d.deviceToken && d.grants) {
          return {
            deviceToken: d.deviceToken,
            deviceId: d.deviceId ?? '',
            grants: d.grants,
          };
        }
        if (d.status === 'revoked') throw new Error('该请求被用户吊销');
      }
      throw new Error('等待批准超时（10 分钟）');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
