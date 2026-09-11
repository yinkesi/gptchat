export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 统一 API 客户端：Cookie 会话 + CSRF 自定义头。 */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-gptchat-web': '1' },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code: string; message: string } };
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? 'ERROR', data.error?.message ?? `请求失败（${res.status}）`);
  }
  return data;
}

export const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

export const fmtDay = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return '今天';
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
