import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProposalPayload, PublicMessage, PublicAgent } from '@shared/schema';
import { useStore } from '../store';
import { Avatar } from '../components/Avatar';
import { MessageBody } from '../components/MessageBody';
import { Modal } from '../components/Modal';
import { fmtDay, fmtTime } from '../lib/api';

export function ChatView({ rightOpen, onToggleRight }: { rightOpen: boolean; onToggleRight: () => void }) {
  const { room, messages, hasMore, agents, me, typingWho, wsStatus, loadMore, sendMessage, forceResolve, setToast } =
    useStore();
  const [text, setText] = useState('');
  const [proposalOpen, setProposalOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // @提及自动补全
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return agents.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 5);
  }, [mentionQuery, agents]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, typingWho]);

  if (!room) {
    return (
      <div className="chat">
        <div className="empty" style={{ margin: 'auto' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>💬</div>
          左侧选择一个工作区，或新建一个开始协作
        </div>
      </div>
    );
  }

  const header = (
    <div className="chat-header">
      <span className="title">{room.name}</span>
      <span className="topic">{room.topic}</span>
      <span className="ws-badge" title={`实时连接：${wsStatus}`}>
        <span className={`dot ${wsStatus === 'open' ? 'ok' : wsStatus === 'closed' ? 'bad' : ''}`} />
        {wsStatus === 'open' ? 'LIVE' : '…'}
      </span>
      <button className="icon-btn" onClick={onToggleRight} title={rightOpen ? '收起侧栏' : '展开侧栏'}>
        {rightOpen ? '▶' : '◀'}
      </button>
    </div>
  );

  function onChange(v: string) {
    setText(v);
    const m = /(?:^|[^\w@])@([\w\u4e00-\u9fa5-]*)$/.exec(v);
    setMentionQuery(m ? (m[1] ?? '') : null);
  }

  function pickMention(a: PublicAgent) {
    setText((prev) => prev.replace(/@([\w\u4e00-\u9fa5-]*)$/, `@${a.name} `));
    setMentionQuery(null);
    taRef.current?.focus();
  }

  async function submit() {
    const body = text.trim();
    if (!body) return;
    stickBottom.current = true;
    try {
      await sendMessage(body);
      setText('');
      setMentionQuery(null);
    } catch {
      setToast('发送失败');
    }
  }

  let lastDay = '';

  return (
    <div className="chat">
      {header}
      <div className="messages" ref={listRef} onScroll={(e) => {
        const el = e.currentTarget;
        stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}>
        {hasMore && (
          <div style={{ textAlign: 'center', padding: '8px' }}>
            <button className="btn sm ghost" onClick={() => void loadMore()}>加载更早的消息</button>
          </div>
        )}
        {messages.map((m) => {
          const day = fmtDay(m.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id === 0 ? `sys-${m.createdAt}` : m.id}>
              {showDay && <div className="day-sep">{day}</div>}
              <MessageRow msg={m} onResolve={forceResolve} meId={me?.id} roomOwnerId={room.ownerId} />
            </div>
          );
        })}
        {typingWho && <div className="typing">✍️ {typingWho} 正在输入…</div>}
      </div>

      <div className="composer">
        {mentionCandidates.length > 0 && (
          <div className="mention-pop">
            {mentionCandidates.map((a) => (
              <button key={a.id} className="mi" onClick={() => pickMention(a)}>
                <Avatar name={a.name} online={a.status === 'online'} />
                <span>{a.name}</span>
                <span className="sub">{a.adapter}</span>
              </button>
            ))}
          </div>
        )}
        <div className="tools">
          <button className="tool-chip" onClick={() => setProposalOpen(true)}>
            📋 发起分工提案
          </button>
        </div>
        <div className="box">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && mentionQuery === null) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={`发消息，@智能体 让它参与讨论（Enter 发送）`}
            rows={1}
          />
          <button className="send" onClick={() => void submit()} aria-label="发送">
            ➤
          </button>
        </div>
        <div className="hint">
          <span>同意发起提案后，智能体将自动投票形成分工</span>
          <span>{text.length}/16000</span>
        </div>
      </div>

      {proposalOpen && <ProposalModal onClose={() => setProposalOpen(false)} onSubmit={async (body, proposal) => {
        await sendMessage(body, { proposal });
        setProposalOpen(false);
        setToast('提案已发起，等待智能体投票');
      }} agents={agents} />}
    </div>
  );
}

function MessageRow({
  msg,
  onResolve,
  meId,
  roomOwnerId,
}: {
  msg: PublicMessage;
  onResolve: (id: string, d: 'accepted' | 'rejected') => Promise<void>;
  meId?: string;
  roomOwnerId: string;
}) {
  if (msg.senderType === 'system') {
    return (
      <div className="msg system-msg">
        <div className="body">
          <MessageBody text={msg.body} />
        </div>
      </div>
    );
  }
  const isAgent = msg.senderType === 'agent';
  return (
    <div className="msg">
      <Avatar name={msg.senderName} />
      <div>
        <div className="meta">
          <span className="who">{msg.senderName}</span>
          <span className={`kind ${isAgent ? 'agent' : ''}`}>{isAgent ? 'AGENT' : 'MEMBER'}</span>
          <span className="time">{fmtTime(msg.createdAt)}</span>
        </div>
        <div className="body">
          <MessageBody text={msg.body} />
        </div>
        {msg.proposal && <ProposalInline p={msg.proposal} canResolve={meId === roomOwnerId} onResolve={onResolve} />}
      </div>
    </div>
  );
}

function ProposalInline({
  p,
  canResolve,
  onResolve,
}: {
  p: ProposalPayload;
  canResolve: boolean;
  onResolve: (id: string, d: 'accepted' | 'rejected') => Promise<void>;
}) {
  return (
    <div className="proposal-card">
      <div className="p-head">
        <span className="p-title">📋 {p.title}</span>
        <span className={`p-status ${p.status}`}>
          {p.status === 'open' ? '等待共识' : p.status === 'accepted' ? '共识达成' : p.status === 'rejected' ? '已否决' : '已过期'}
        </span>
      </div>
      {p.body && <div style={{ color: 'var(--ink-2)', fontSize: 13, marginBottom: 6 }}>{p.body}</div>}
      {p.tasks.map((t, i) => (
        <div className="p-task" key={i}>
          <span>▪ {t.title}</span>
          <span className="assignee">{(t.assigneeName || (t.assigneeAgentId ? '已指派' : '') || '待认领')}</span>
        </div>
      ))}
      <div className="p-votes">
        {p.votes.map((v, i) => (
          <span key={i} className={`vote-chip ${v.choice}`}>
            {v.voterName} {v.choice === 'approve' ? '赞成' : '反对'}
          </span>
        ))}
        {p.votes.length === 0 && p.status === 'open' && <span className="vote-chip">等待智能体投票…</span>}
      </div>
      {canResolve && p.status === 'open' && (
        <div className="p-actions">
          <button className="btn sm" onClick={() => void onResolve(p.id, 'accepted')}>✓ 直接通过</button>
          <button className="btn sm danger" onClick={() => void onResolve(p.id, 'rejected')}>✗ 否决</button>
        </div>
      )}
    </div>
  );
}

function ProposalModal({
  onClose,
  onSubmit,
  agents,
}: {
  onClose: () => void;
  onSubmit: (body: string, proposal: unknown) => Promise<void>;
  agents: PublicAgent[];
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tasks, setTasks] = useState<Array<{ title: string; assignee: string }>>([
    { title: '', assignee: '' },
  ]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const clean = tasks.filter((t) => t.title.trim());
    if (!title.trim()) return setErr('请填写提案标题');
    if (clean.length === 0) return setErr('至少一项任务');
    setBusy(true);
    try {
      await onSubmit(
        body.trim() || `发起了提案《${title.trim()}》，请各位智能体投票表决。`,
        {
          title: title.trim(),
          body: body.trim(),
          tasks: clean.map((t) => ({
            title: t.title.trim(),
            ...(t.assignee ? { assigneeName: t.assignee } : {}),
          })),
        },
      );
    } catch {
      setErr('提交失败，请重试');
      setBusy(false);
    }
  }

  return (
    <Modal title="发起分工提案" onClose={onClose}>
      <div className="field">
        <label>提案标题</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="例如：GIS 小组作业分工 v1" />
      </div>
      <div className="field">
        <label>说明（可选）</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={4000} placeholder="背景、要求、截止时间…" />
      </div>
      <div className="field">
        <label>任务分工（可指派给智能体，也可以留空待认领）</label>
        {tasks.map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input
              value={t.title}
              onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              placeholder={`任务 ${i + 1}`}
              maxLength={200}
            />
            <select
              value={t.assignee}
              onChange={(e) => setTasks(tasks.map((x, j) => (j === i ? { ...x, assignee: e.target.value } : x)))}
              style={{ width: 150 }}
            >
              <option value="">待认领</option>
              {agents.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
            <button className="icon-btn" onClick={() => setTasks(tasks.filter((_, j) => j !== i))} aria-label="删除任务">
              ✕
            </button>
          </div>
        ))}
        {tasks.length < 12 && (
          <button className="btn sm ghost" onClick={() => setTasks([...tasks, { title: '', assignee: '' }])}>
            ＋ 添加任务
          </button>
        )}
      </div>
      {err && <div className="form-err">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          发起提案
        </button>
      </div>
    </Modal>
  );
}
