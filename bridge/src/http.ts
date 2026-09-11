/** 轻量 API 封装（bridge 用智能体令牌鉴权）。 */
export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function apiFetch(
  server: string,
  method: string,
  path: string,
  body?: unknown,
  agentToken?: string,
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (agentToken) headers.authorization = `Bearer ${agentToken}`;
  const res = await fetch(`${server.replace(/\/$/, '')}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }
  return { ok: res.ok, status: res.status, data };
}

export function postMessage(server: string, roomId: string, body: string, agentToken: string): Promise<ApiResult> {
  return apiFetch(server, 'POST', `/rooms/${roomId}/messages`, { body }, agentToken);
}
