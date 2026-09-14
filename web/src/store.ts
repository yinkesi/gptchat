import { create } from 'zustand';
import type { PublicAgent, PublicMessage, PublicRoom, PublicUser, ProposalPayload, S2CEvent, TaskPayload } from '@shared/schema';
import { api } from './lib/api';
import { WsClient } from './lib/ws';

export interface RoomListItem extends PublicRoom {
  memberCount?: number;
  agentCount?: number;
}

export type View = { kind: 'chat'; roomId: string | null } | { kind: 'agents' } | { kind: 'devices' };

interface Store {
  me: PublicUser | null;
  wsStatus: 'connecting' | 'open' | 'closed';
  view: View;
  rooms: RoomListItem[];
  // 当前房间详情
  room: PublicRoom | null;
  role: string;
  members: PublicUser[];
  agents: PublicAgent[];
  messages: PublicMessage[];
  hasMore: boolean;
  tasks: TaskPayload[];
  proposals: ProposalPayload[];
  typingWho: string | null;
  ws: WsClient;
  toast: string | null;

  setView(view: View): void;
  setToast(t: string | null): void;
  setWsStatus(s: Store['wsStatus']): void;
  loadMe(): Promise<boolean>;
  logout(): Promise<void>;
  loadRooms(): Promise<void>;
  openRoom(roomId: string | null): Promise<void>;
  loadMore(): Promise<void>;
  sendMessage(body: string, extra?: { proposal?: unknown }): Promise<void>;
  forceResolve(proposalId: string, decision: 'accepted' | 'rejected'): Promise<void>;
  setTaskStatus(taskId: string, status: string): Promise<void>;
  updateRoom(patch: { topic?: string; settings?: Record<string, unknown> }): Promise<void>;
  addMember(username: string): Promise<void>;
  addAgent(agentId: string): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
  handleEvent(ev: S2CEvent): void;
}

export const wsClient = new WsClient();
let typingTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => ({
  me: null,
  wsStatus: 'connecting',
  view: { kind: 'chat', roomId: null },
  rooms: [],
  room: null,
  role: 'member',
  members: [],
  agents: [],
  messages: [],
  hasMore: false,
  tasks: [],
  proposals: [],
  typingWho: null,
  ws: wsClient,
  toast: null,

  setView(view) {
    set({ view });
    if (view.kind === 'chat') void get().openRoom(view.roomId);
  },
  setToast(toast) {
    set({ toast });
    if (toast) setTimeout(() => set((s) => (s.toast === toast ? { toast: null } : s)), 2600);
  },
  setWsStatus(wsStatus) {
    set({ wsStatus });
  },

  async loadMe() {
    try {
      const r = await api<{ user: PublicUser }>('GET', '/api/v1/me');
      set({ me: r.user });
      wsClient.connect();
      await get().loadRooms();
      return true;
    } catch {
      return false;
    }
  },

  async logout() {
    await api('POST', '/api/v1/auth/logout').catch(() => undefined);
    wsClient.close();
    set({ me: null, rooms: [], view: { kind: 'chat', roomId: null }, room: null, messages: [] });
  },

  async loadRooms() {
    const r = await api<{ rooms: RoomListItem[] }>('GET', '/api/v1/rooms');
    set({ rooms: r.rooms });
  },

  async openRoom(roomId) {
    if (!roomId) {
      set({ room: null, members: [], agents: [], messages: [], tasks: [], proposals: [] });
      return;
    }
    try {
      const [detail, msgs, tasks, proposals] = await Promise.all([
        api<{ room: PublicRoom; role: string; members: PublicUser[]; agents: PublicAgent[] }>(
          'GET',
          `/api/v1/rooms/${roomId}`,
        ),
        api<{ messages: PublicMessage[]; hasMore: boolean }>(`GET`, `/api/v1/rooms/${roomId}/messages?limit=50`),
        api<{ tasks: TaskPayload[] }>(`GET`, `/api/v1/rooms/${roomId}/tasks`),
        api<{ proposals: ProposalPayload[] }>(`GET`, `/api/v1/rooms/${roomId}/proposals`),
      ]);
      set({
        room: detail.room,
        role: detail.role,
        members: detail.members,
        agents: detail.agents,
        messages: msgs.messages,
        hasMore: msgs.hasMore,
        tasks: tasks.tasks,
        proposals: proposals.proposals,
      });
      wsClient.send({ type: 'room.join', roomId });
    } catch {
      get().setToast('无法打开该房间');
    }
  },

  async loadMore() {
    const { room, messages } = get();
    if (!room || messages.length === 0) return;
    const r = await api<{ messages: PublicMessage[]; hasMore: boolean }>(
      'GET',
      `/api/v1/rooms/${room.id}/messages?before=${messages[0]!.id}&limit=50`,
    );
    set({ messages: [...r.messages, ...get().messages], hasMore: r.hasMore });
  },

  async sendMessage(body, extra) {
    const { room } = get();
    if (!room) return;
    await api<{ message: PublicMessage }>('POST', `/api/v1/rooms/${room.id}/messages`, {
      body,
      ...(extra ?? {}),
    });
    // message.new 由 WS 回显
  },

  async forceResolve(proposalId, decision) {
    const r = await api<{ proposal: ProposalPayload }>('POST', `/api/v1/proposals/${proposalId}/resolve`, {
      decision,
    });
    set((s) => ({ proposals: s.proposals.map((p) => (p.id === proposalId ? r.proposal : p)) }));
    get().setToast(decision === 'accepted' ? '已通过该提案' : '已否决该提案');
  },

  async setTaskStatus(taskId, status) {
    const r = await api<{ task: TaskPayload }>('PATCH', `/api/v1/tasks/${taskId}`, { status });
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? r.task : t)) }));
  },

  async updateRoom(patch) {
    const { room } = get();
    if (!room) return;
    const r = await api<{ room: PublicRoom }>('PATCH', `/api/v1/rooms/${room.id}`, patch);
    set({ room: r.room });
    void get().loadRooms();
  },

  async addMember(username) {
    const { room } = get();
    if (!room) return;
    await api('POST', `/api/v1/rooms/${room.id}/members`, { username });
    await get().openRoom(room.id);
    get().setToast(`已邀请 ${username}`);
  },

  async addAgent(agentId) {
    const { room } = get();
    if (!room) return;
    await api('POST', `/api/v1/rooms/${room.id}/agents`, { agentId });
    await get().openRoom(room.id);
    get().setToast('智能体已加入房间');
  },

  async removeAgent(agentId) {
    const { room } = get();
    if (!room) return;
    await api('DELETE', `/api/v1/rooms/${room.id}/agents/${agentId}`);
    await get().openRoom(room.id);
  },

  handleEvent(ev) {
    const { room } = get();
    switch (ev.type) {
      case 'message.new': {
        const m = ev.message as PublicMessage;
        if (room && m.roomId === room.id) {
          set((s) =>
            s.messages.some((x) => x.id === m.id && m.id !== 0)
              ? s
              : { messages: [...s.messages, m], typingWho: null },
          );
        }
        break;
      }
      case 'typing': {
        if (room && ev.roomId === room.id) {
          set({ typingWho: String(ev.who) });
          if (typingTimer) clearTimeout(typingTimer);
          typingTimer = setTimeout(() => set({ typingWho: null }), 2200);
        }
        break;
      }
      case 'presence': {
        const arr = ev.agents as Array<{ agentId: string; status: 'online' | 'offline' }>;
        set((s) => ({
          agents: s.agents.map((a) => {
            const hit = arr.find((x) => x.agentId === a.id);
            return hit ? { ...a, status: hit.status } : a;
          }),
        }));
        break;
      }
      case 'proposal.update': {
        const p = ev.proposal as ProposalPayload;
        if (room && p.roomId === room.id) {
          set((s) => ({
            proposals: [p, ...s.proposals.filter((x) => x.id !== p.id)],
            messages: s.messages.map((m) =>
              m.proposal?.id === p.id ? { ...m, proposal: p } : m,
            ),
          }));
        }
        break;
      }
      case 'task.update': {
        const t = ev.task as TaskPayload;
        if (room && t.roomId === room.id) {
          set((s) => {
            const exists = s.tasks.some((x) => x.id === t.id);
            return { tasks: exists ? s.tasks.map((x) => (x.id === t.id ? t : x)) : [...s.tasks, t] };
          });
        }
        break;
      }
      default:
        break;
    }
  },
}));

// 将 WS 事件接入 store（App 挂载时调用一次）
export function bindWs(): () => void {
  const offMsg = wsClient.onMessage((ev) => useStore.getState().handleEvent(ev));
  const offStatus = wsClient.onStatus((s) => {
    useStore.getState().setWsStatus(s);
    // 断线重连后服务器端订阅已清空，必须重新加入当前房间，否则收不到事件
    if (s === 'open') {
      const { room, me } = useStore.getState();
      if (room && me) wsClient.send({ type: 'room.join', roomId: room.id });
    }
  });
  return () => {
    offMsg();
    offStatus();
  };
}
