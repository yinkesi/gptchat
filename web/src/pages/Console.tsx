import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Avatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { ChatView } from './ChatView';
import { RightPanel } from './RightPanel';
import { AgentsView } from './AgentsView';
import { DevicesView } from './DevicesView';

export function Console() {
  const { rooms, view, setView, loadRooms, setToast } = useStore();
  const [rightOpen, setRightOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    void loadRooms();
  }, [view, loadRooms]);

  const roomId = view.kind === 'chat' ? view.roomId : null;
  const currentRoom = rooms.find((r) => r.id === roomId) ?? null;
  const showRight = rightOpen && view.kind === 'chat' && !!currentRoom;

  return (
    <div className={`console ${showRight ? 'right-open' : ''}`}>
      <Sidebar onCreate={() => setCreateOpen(true)} />

      {view.kind === 'chat' && (
        <ChatView rightOpen={showRight} onToggleRight={() => setRightOpen(!rightOpen)} />
      )}
      {view.kind === 'agents' && <AgentsView />}
      {view.kind === 'devices' && <DevicesView />}

      {showRight && currentRoom && <RightPanel onClose={() => setRightOpen(false)} />}

      {createOpen && (
        <CreateRoomModal
          onClose={() => setCreateOpen(false)}
          onDone={async (id) => {
            setCreateOpen(false);
            await loadRooms();
            setView({ kind: 'chat', roomId: id });
            setToast('工作区已创建，试试 @ 智能体吧');
          }}
        />
      )}
    </div>
  );
}

function Sidebar({ onCreate }: { onCreate: () => void }) {
  const { me, rooms, view, setView, wsStatus, logout } = useStore();
  if (!me) return null;
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/favicon.svg" alt="" />
        <span className="name">
          gpt<span className="grad-text">chat</span>
        </span>
      </div>
      <div className="section">
        <div className="section-title">
          工作区
          <button onClick={onCreate} title="新建工作区">＋</button>
        </div>
        {rooms.length === 0 && (
          <div style={{ color: 'var(--ink-3)', fontSize: 12.5, padding: '6px 12px' }}>还没有工作区，点 ＋ 创建</div>
        )}
        {rooms.map((r) => (
          <button
            key={r.id}
            className={`nav-item ${view.kind === 'chat' && view.roomId === r.id ? 'active' : ''}`}
            onClick={() => setView({ kind: 'chat', roomId: r.id })}
          >
            <span className="hash">#</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.name}</span>
            {!!r.agentCount && r.agentCount > 0 && (
              <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>🤖{r.agentCount}</span>
            )}
          </button>
        ))}

        <div className="section-title" style={{ marginTop: 14 }}>控制台</div>
        <button className={`nav-item ${view.kind === 'agents' ? 'active' : ''}`} onClick={() => setView({ kind: 'agents' })}>
          🤖 我的智能体
        </button>
        <button className={`nav-item ${view.kind === 'devices' ? 'active' : ''}`} onClick={() => setView({ kind: 'devices' })}>
          🖥️ 设备接入
        </button>
      </div>
      <div className="me">
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <Avatar name={me.displayName} />
          <span className="who">
            <span className="n" style={{ display: 'block' }}>{me.displayName}</span>
            <span className="u">@{me.username}</span>
          </span>
        </span>
        <span className={`ws-badge`} title={wsStatus}>
          <span className={`dot ${wsStatus === 'open' ? 'ok' : wsStatus === 'closed' ? 'bad' : ''}`} />
        </span>
        <button className="icon-btn" title="退出登录" onClick={() => void logout()}>
          ⏻
        </button>
      </div>
    </aside>
  );
}

function CreateRoomModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [demo, setDemo] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ room: { id: string } }>('POST', '/api/v1/rooms', {
        name: name.trim(),
        topic: topic.trim(),
        withDemoAgent: demo,
      });
      await onDone(r.room.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
      setBusy(false);
    }
  }

  return (
    <Modal title="新建工作区" onClose={onClose}>
      <div className="field">
        <label>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="例如：GIS 小组作业" autoFocus />
      </div>
      <div className="field">
        <label>主题（可选）</label>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={200} placeholder="一句话说明这个群聊的目的" />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
        <span>加入内置演示智能体 Echo（零配置体验 @ 触发）</span>
      </label>
      {err && <div className="form-err">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          创建
        </button>
      </div>
    </Modal>
  );
}
