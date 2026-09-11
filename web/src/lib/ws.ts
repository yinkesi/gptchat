export type WsHandler = (event: unknown) => void;

/**
 * WebSocket 客户端：自动重连（指数退避，封顶 15s）。
 * 鉴权走同源 Cookie（开发环境经 vite 代理转发），无需在 URL 上带令牌。
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  private handlers = new Set<WsHandler>();
  private statusHandlers = new Set<(s: 'connecting' | 'open' | 'closed') => void>();

  constructor(private path = '/ws') {}

  onMessage(h: WsHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onStatus(h: (s: 'connecting' | 'open' | 'closed') => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  private setStatus(s: 'connecting' | 'open' | 'closed'): void {
    for (const h of this.statusHandlers) h(s);
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.closedByUser = false;
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${this.path}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      for (const h of this.handlers) h(data);
    };
    ws.onclose = () => {
      this.setStatus('closed');
      if (!this.closedByUser) {
        const delay = Math.min(15000, 600 * 2 ** this.retry++);
        setTimeout(() => this.connect(), delay);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  send(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
