import { useState } from 'react';
import { useStore } from '../store';
import { Avatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';

interface DeviceItem {
  id: string;
  machineName: string;
  platform: string;
  pairCode: string;
  status: 'pending' | 'approved' | 'revoked';
  requestedAt: number;
  candidates: Array<{ name: string; adapter: string; model?: string; approved: boolean; agentId?: string }>;
}

export function DevicesView() {
  const { setToast } = useStore();
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [claimed, setClaimed] = useState<DeviceItem | null>(null);

  async function load() {
    const r = await api<{ devices: DeviceItem[] }>('GET', '/api/v1/my/devices');
    setDevices(r.devices);
  }
  if (devices === null) void load();

  async function revoke(id: string) {
    if (!confirm('确定吊销该设备？其上所有智能体将立即断开。')) return;
    await api('POST', `/api/v1/my/devices/${id}/revoke`);
    await load();
    setToast('设备已吊销');
  }

  async function remove(id: string) {
    if (!confirm('删除该设备记录？')) return;
    await api('DELETE', `/api/v1/my/devices/${id}`);
    await load();
  }

  async function approve(device: DeviceItem, picks: string[]) {
    const r = await api<{ device: DeviceItem }>('POST', `/api/v1/my/devices/${device.id}/approve`, {
      candidates: device.candidates.map((c) => ({ name: c.name, approved: picks.includes(c.name) })),
    });
    setClaimed(r.device);
    await load();
    setToast('已批准接入，新电脑上的 bridge 将自动拿到智能体');
  }

  const pending = devices?.filter((d) => d.status === 'pending') ?? [];

  return (
    <div className="page">
      <div className="head">
        <div>
          <h2>设备接入</h2>
          <div className="desc">把新电脑上的 CLI 智能体接入你的 gptchat —— 全程需要你在两端确认</div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setPairOpen(true)}>＋ 接入新电脑</button>
      </div>

      <div className="card">
        <div className="row">
          <div style={{ fontSize: 20 }}>🖥️</div>
          <div>
            <div className="title">在新电脑上如何接入？</div>
            <div className="sub" style={{ lineHeight: 1.9 }}>
              1. 安装 bridge：<span className="mono">npm i -g @gptchat/bridge</span>
              <br />
              2. 运行 <span className="mono">gptchat-bridge connect --server https://你的服务器</span>，屏幕会显示一个配对码
              <br />
              3. 回到这里点「接入新电脑」，输入配对码，勾选允许接入的智能体 —— 完成
            </div>
          </div>
        </div>
      </div>

      {claimed && (
        <div className="token-reveal">
          <div className="warn">✓ 设备「{claimed.machineName}」已批准。以下智能体已在本服务器创建，等待新电脑上的 bridge 领取后上线：</div>
          <div>{claimed.candidates.filter((c) => c.approved).map((c) => c.name).join('、')}</div>
        </div>
      )}

      <h4 style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '18px 2px 10px' }}>
        待处理 ({pending.length})
      </h4>
      {pending.length === 0 && <div className="empty">没有等待处理的接入请求</div>}
      {pending.map((d) => (
        <PendingCard key={d.id} device={d} onApprove={approve} />
      ))}

      <h4 style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '18px 2px 10px' }}>
        全部设备
      </h4>
      {devices?.filter((d) => d.status !== 'pending').length === 0 && <div className="empty">还没有已接入的设备</div>}
      {devices?.filter((d) => d.status !== 'pending').map((d) => (
        <div className="card" key={d.id}>
          <div className="row">
            <Avatar name={d.machineName} size="lg" online={d.status === 'approved'} />
            <div>
              <div className="title">{d.machineName}</div>
              <div className="sub">
                {d.platform} · 配对码 {d.pairCode} · {new Date(d.requestedAt).toLocaleString()}
              </div>
            </div>
            <span className="spacer" />
            <span className={`tag ${d.status === 'approved' ? 'green' : d.status === 'revoked' ? 'red' : ''}`}>
              {d.status === 'approved' ? '已接入' : d.status === 'revoked' ? '已吊销' : '待处理'}
            </span>
            {d.status === 'approved' && (
              <button className="btn sm danger" onClick={() => void revoke(d.id)}>吊销</button>
            )}
            <button className="btn sm ghost" onClick={() => void remove(d.id)}>删除</button>
          </div>
          {d.candidates.filter((c) => c.approved).length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {d.candidates.filter((c) => c.approved).map((c) => (
                <span key={c.name} className="tag violet">{c.name}</span>
              ))}
            </div>
          )}
        </div>
      ))}

      {pairOpen && (
        <PairModal
          onClose={() => setPairOpen(false)}
          onClaimed={async (d) => {
            setPairOpen(false);
            setClaimed(d);
            await load();
          }}
        />
      )}
    </div>
  );
}

function PendingCard({
  device,
  onApprove,
}: {
  device: DeviceItem;
  onApprove: (d: DeviceItem, picks: string[]) => Promise<void>;
}) {
  const [picks, setPicks] = useState<string[]>(device.candidates.map((c) => c.name));
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <Avatar name={device.machineName} size="lg" />
        <div>
          <div className="title">{device.machineName} 请求接入</div>
          <div className="sub">
            {device.platform} · 配对码 {device.pairCode}（与对方屏幕上的编码一致才可信）
          </div>
        </div>
      </div>
      <div style={{ color: 'var(--ink-2)', fontSize: 13, margin: '6px 0 10px' }}>
        本机发现了这些智能体候选，勾选你允许接入的：
      </div>
      {device.candidates.map((c) => (
        <label className="check-row" key={c.name}>
          <input
            type="checkbox"
            checked={picks.includes(c.name)}
            onChange={(e) =>
              setPicks(e.target.checked ? [...picks, c.name] : picks.filter((n) => n !== c.name))
            }
          />
          <span>{c.name}</span>
          <span style={{ marginLeft: 'auto' }} className="tag">
            {c.adapter}
          </span>
        </label>
      ))}
      <div className="actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
        <button className="btn ghost" disabled>忽略（可稍后吊销/删除）</button>
        <button className="btn primary" disabled={picks.length === 0} onClick={() => void onApprove(device, picks)}>
          批准接入（{picks.length} 个智能体）
        </button>
      </div>
    </div>
  );
}

function PairModal({ onClose, onClaimed }: { onClose: () => void; onClaimed: (d: DeviceItem) => Promise<void> }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      const r = await api<{ device: DeviceItem }>('POST', '/api/v1/my/devices/claim', {
        pairCode: code.toUpperCase(),
      });
      await onClaimed(r.device);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '认领失败');
      setBusy(false);
    }
  }

  return (
    <Modal title="接入新电脑" onClose={onClose}>
      <div style={{ color: 'var(--ink-2)', fontSize: 13.5, marginBottom: 12 }}>
        在新电脑的 bridge 界面上会显示一个 6 位配对码。输入它完成两端匹配 ——
        <b> 只有编码一致才可信</b>，防止陌生设备冒充。
      </div>
      <input
        className="mono"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
        placeholder="ABC123"
        style={{ textAlign: 'center', fontSize: 24, letterSpacing: '0.3em', padding: '12px' }}
        autoFocus
      />
      {err && <div className="form-err">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || code.length !== 6} onClick={() => void submit()}>
          认领设备
        </button>
      </div>
    </Modal>
  );
}
