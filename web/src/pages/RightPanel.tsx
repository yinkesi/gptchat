import { useState } from 'react';
import { useStore } from '../store';
import { Avatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';

export function RightPanel({ onClose }: { onClose: () => void }) {
  const { room, role, members, agents, tasks, updateRoom, addMember, addAgent, removeAgent, setTaskStatus, me } =
    useStore();
  const [tab, setTab] = useState<'people' | 'tasks' | 'settings'>('people');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const isOwner = role === 'owner' && !!me;

  if (!room) return null;

  return (
    <aside className="right-panel">
      <div className="tabs">
        <button className={`tab ${tab === 'people' ? 'active' : ''}`} onClick={() => setTab('people')}>
          成员
        </button>
        <button className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
          任务 {tasks.length > 0 && `(${tasks.length})`}
        </button>
        <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          设置
        </button>
      </div>
      <div className="content">
        {tab === 'people' && (
          <>
            <h4>人类成员 ({members.length})</h4>
            {members.map((u) => (
              <div className="member-row" key={u.id}>
                <Avatar name={u.displayName} />
                <div>
                  <div>{u.displayName}</div>
                  <div className="sub">@{u.username}</div>
                </div>
                <span className="spacer" />
                {u.id === room.ownerId && <span className="tag violet">房主</span>}
              </div>
            ))}
            <div style={{ padding: '6px' }}>
              <button className="btn sm ghost" onClick={() => setInviteOpen(true)}>＋ 邀请成员</button>
            </div>

            <h4>智能体 ({agents.length})</h4>
            {agents.map((a) => (
              <div className="member-row" key={a.id}>
                <Avatar name={a.name} online={a.status === 'online'} />
                <div>
                  <div>{a.name}</div>
                  <div className="sub">
                    {a.adapter} · {a.kind === 'builtin' ? '内置' : a.kind === 'bridge' ? '本机接入' : 'API'}
                  </div>
                </div>
                <span className="spacer" />
                {(isOwner || a.ownerId === me?.id) && a.kind !== 'builtin' && (
                  <button className="icon-btn" title="移出房间" onClick={() => void removeAgent(a.id)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div style={{ padding: '6px' }}>
              <button className="btn sm ghost" onClick={() => setAddAgentOpen(true)}>＋ 拉入我的智能体</button>
            </div>
          </>
        )}

        {tab === 'tasks' && (
          <>
            <h4>分工任务</h4>
            {tasks.length === 0 && <div className="empty">还没有任务。发起一个分工提案，共识达成后自动生成。</div>}
            {tasks.map((t) => (
              <div className="task-row" key={t.id}>
                <span className={`t-status ${t.status}`}>{t.status.replace('_', '-')}</span>
                <span style={{ flex: 1 }}>{t.title}</span>
                {t.assigneeName && <span className="t-assignee">@{t.assigneeName}</span>}
                {t.status !== 'done' && t.status !== 'cancelled' && (
                  <button
                    className="btn sm ghost"
                    onClick={() => void setTaskStatus(t.id, t.status === 'pending' ? 'in_progress' : 'done')}
                  >
                    {t.status === 'pending' ? '开始' : '完成'}
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {tab === 'settings' && (
          <>
            <h4>房间设置{!isOwner && '（仅房主可改）'}</h4>
            <div className="field">
              <label>房间主题</label>
              <input
                defaultValue={room.topic}
                maxLength={200}
                disabled={!isOwner}
                onBlur={(e) => e.target.value !== room.topic && void updateRoom({ topic: e.target.value })}
              />
            </div>
            <div className="setting-row">
              <div>
                智能体自动回复
                <div className="desc">被 @ 时自动参与讨论</div>
              </div>
              <button
                className={`toggle ${room.settings.agentAutoReply ? 'on' : ''}`}
                disabled={!isOwner}
                aria-label="智能体自动回复"
                onClick={() => void updateRoom({ settings: { agentAutoReply: !room.settings.agentAutoReply } })}
              />
            </div>
            <div className="setting-row">
              <div>
                连续发言上限
                <div className="desc">超过后暂停自动回复，防失控</div>
              </div>
              <input
                type="number"
                min={1}
                max={50}
                defaultValue={room.settings.maxAgentChain}
                disabled={!isOwner}
                style={{ width: 74 }}
                onBlur={(e) => {
                  const v = Math.min(50, Math.max(1, Number(e.target.value) || 8));
                  if (v !== room.settings.maxAgentChain) void updateRoom({ settings: { maxAgentChain: v } });
                }}
              />
            </div>
            <div className="setting-row">
              <div>
                共识通过比例
                <div className="desc">赞成票需占房间智能体的比例</div>
              </div>
              <select
                defaultValue={String(room.settings.consensusRatio)}
                disabled={!isOwner}
                style={{ width: 110 }}
                onChange={(e) => void updateRoom({ settings: { consensusRatio: Number(e.target.value) } })}
              >
                <option value="1">全体同意</option>
                <option value="0.75">3/4 多数</option>
                <option value="0.5">过半数</option>
                <option value="0.34">1/3 即可</option>
              </select>
            </div>
          </>
        )}
      </div>

      {inviteOpen && (
        <InviteModal
          onClose={() => setInviteOpen(false)}
          onSubmit={async (username) => {
            await addMember(username);
            setInviteOpen(false);
          }}
        />
      )}
      {addAgentOpen && (
        <AddAgentModal
          onClose={() => setAddAgentOpen(false)}
          onSubmit={async (agentId) => {
            await addAgent(agentId);
            setAddAgentOpen(false);
          }}
        />
      )}
    </aside>
  );
}

function InviteModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (u: string) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; username: string; displayName: string }>>([]);
  const [err, setErr] = useState('');

  async function search() {
    if (q.trim().length < 1) return;
    try {
      const r = await api<{ users: Array<{ id: string; username: string; displayName: string }> }>(
        'GET',
        `/api/v1/users?q=${encodeURIComponent(q.trim())}`,
      );
      setResults(r.users);
      if (r.users.length === 0) setErr('没有找到该用户');
      else setErr('');
    } catch {
      setErr('搜索失败');
    }
  }

  return (
    <Modal title="邀请成员" onClose={onClose}>
      <div className="field">
        <label>输入用户名搜索</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如 xiaoming" onKeyDown={(e) => e.key === 'Enter' && void search()} />
          <button className="btn" onClick={() => void search()}>搜索</button>
        </div>
      </div>
      {err && <div className="form-err">{err}</div>}
      {results.map((u) => (
        <div className="member-row" key={u.id}>
          <Avatar name={u.displayName} />
          <div>
            <div>{u.displayName}</div>
            <div className="sub">@{u.username}</div>
          </div>
          <span className="spacer" />
          <button
            className="btn sm primary"
            onClick={async () => {
              await onSubmit(u.username);
              onClose();
            }}
          >
            邀请
          </button>
        </div>
      ))}
    </Modal>
  );
}

function AddAgentModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (id: string) => Promise<void> }) {
  const { agents: roomAgents } = useStore();
  const [list, setList] = useState<Array<{ id: string; name: string; kind: string; adapter: string }> | null>(null);
  const [err, setErr] = useState('');
  const inRoom = new Set(roomAgents.map((a) => a.id));

  async function load() {
    try {
      const r = await api<{ agents: Array<{ id: string; name: string; kind: string; adapter: string }> }>(
        'GET',
        '/api/v1/my/agents',
      );
      setList(r.agents);
    } catch {
      setErr('加载失败');
    }
  }
  if (list === null && !err) void load();

  return (
    <Modal title="拉入我的智能体" onClose={onClose}>
      {list !== null && list.length === 0 && (
        <div className="empty">
          还没有自己的智能体。去「智能体」页创建一个，或在本机用 bridge 接入 CLI。
        </div>
      )}
      {list?.filter((a) => !inRoom.has(a.id)).map((a) => (
        <div className="member-row" key={a.id}>
          <Avatar name={a.name} />
          <div>
            <div>{a.name}</div>
            <div className="sub">{a.adapter} · {a.kind}</div>
          </div>
          <span className="spacer" />
          <button className="btn sm primary" onClick={async () => { await onSubmit(a.id); onClose(); }}>
            加入
          </button>
        </div>
      ))}
      {list?.filter((a) => !inRoom.has(a.id)).length === 0 && list.length > 0 && (
        <div className="empty">你的智能体都已在房间里</div>
      )}
      {err && <div className="form-err">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}
