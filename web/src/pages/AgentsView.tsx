import { useState } from 'react';
import { useStore } from '../store';
import { Avatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';

interface AgentItem {
  id: string;
  name: string;
  kind: string;
  adapter: string;
  description: string;
  status: string;
  model: string | null;
}

export function AgentsView() {
  const { setToast } = useStore();
  const [list, setList] = useState<AgentItem[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [freshToken, setFreshToken] = useState<{ name: string; token: string } | null>(null);

  async function load() {
    const r = await api<{ agents: AgentItem[] }>('GET', '/api/v1/my/agents');
    setList(r.agents);
  }
  if (list === null) void load();

  async function del(id: string) {
    if (!confirm('确定删除该智能体？此操作不可恢复。')) return;
    await api('DELETE', `/api/v1/agents/${id}`);
    await load();
    setToast('已删除');
  }

  async function rotate(id: string, name: string) {
    const r = await api<{ token: string }>('POST', `/api/v1/agents/${id}/rotate`);
    setFreshToken({ name, token: r.token });
  }

  return (
    <div className="page">
      <div className="head">
        <div>
          <h2>我的智能体</h2>
          <div className="desc">创建 API 智能体接入任意程序，或在设备页通过 bridge 接入本机 CLI</div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setCreateOpen(true)}>＋ 创建智能体</button>
      </div>

      {freshToken && (
        <div className="token-reveal">
          <div className="warn">⚠ 令牌仅此一次显示，请立即复制保存 —— {freshToken.name}</div>
          <div>{freshToken.token}</div>
        </div>
      )}

      {list !== null && list.length === 0 && (
        <div className="empty">还没有智能体。创建一个，或在「设备」页把本机 CLI 智能体接进来。</div>
      )}
      {list?.map((a) => (
        <div className="card" key={a.id}>
          <div className="row">
            <Avatar name={a.name} size="lg" online={a.status === 'online'} />
            <div>
              <div className="title">{a.name}</div>
              <div className="sub">
                {a.description || '—'}
              </div>
            </div>
            <span className="spacer" />
            <span className={`tag ${a.kind === 'builtin' ? '' : 'violet'}`}>
              {a.kind === 'builtin' ? '内置' : a.kind === 'bridge' ? 'bridge' : 'api'}
            </span>
            <span className="tag">{a.adapter}</span>
            <button className="btn sm ghost" onClick={() => void rotate(a.id, a.name)}>重置令牌</button>
            {a.kind !== 'builtin' && (
              <button className="btn sm danger" onClick={() => void del(a.id)}>删除</button>
            )}
          </div>
        </div>
      ))}

      {createOpen && (
        <CreateAgentModal
          onClose={() => setCreateOpen(false)}
          onDone={async (name, token) => {
            setCreateOpen(false);
            setFreshToken({ name, token });
            await load();
          }}
        />
      )}
    </div>
  );
}

function CreateAgentModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (name: string, token: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [adapter, setAdapter] = useState('generic');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ agent: { name: string }; token: string }>('POST', '/api/v1/my/agents', {
        name: name.trim(),
        kind: 'api',
        adapter,
        description: description.trim(),
      });
      await onDone(r.agent.name, r.token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '创建失败');
      setBusy(false);
    }
  }

  return (
    <Modal title="创建 API 智能体" onClose={onClose}>
      <div className="field">
        <label>名称（群里 @ 它时使用）</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} placeholder="例如 Writer-Bot" />
      </div>
      <div className="field">
        <label>适配器标识（信息性，标记它如何被驱动）</label>
        <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
          <option value="generic">generic · 通用（HTTP 轮询驱动）</option>
          <option value="claude">claude · Claude Code</option>
          <option value="codex">codex · Codex CLI</option>
          <option value="gemini">gemini · Gemini CLI</option>
        </select>
      </div>
      <div className="field">
        <label>描述（可选）</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="擅长什么、负责什么" />
      </div>
      <div className="form-ok" style={{ marginBottom: 6 }}>
        创建后通过 <span className="mono">POST /api/v1/rooms/:id/messages</span> 与{' '}
        <span className="mono">GET /api/v1/agents/@me/inbox</span> 参与群聊，令牌仅显示一次。
      </div>
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
