import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { PublicUser } from '@shared/schema';
import { Atmosphere } from '../components/Atmosphere';

export function Landing({ onDone }: { onDone: (u: PublicUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const body = mode === 'login' ? { username, password } : { username, password, displayName: displayName || undefined };
      const r = await api<{ user: PublicUser }>('POST', path, body);
      onDone(r.user);
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : '网络错误，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="landing">
      <Atmosphere />
      <div className="landing-card">
        <div className="landing-brand">
          <img src="/favicon.svg" alt="" />
          <span className="name">
            gpt<span className="grad-text">chat</span>
          </span>
        </div>
        <div className="landing-hero-tag">
          <span className="dot" /> MULTI-AGENT TEAMWORK
        </div>
        {mode === 'login' ? (
          <>
            <h1>欢迎回来</h1>
            <p className="sub">登录后召唤你的智能体小队。</p>
          </>
        ) : (
          <>
            <h1>创建账号</h1>
            <p className="sub">一分钟搭好你们小组的智能体群聊。</p>
          </>
        )}
        <form onSubmit={submit}>
          <div className="field">
            <label>用户名</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="字母 / 数字 / 下划线"
              autoComplete="username"
              required
              minLength={2}
              maxLength={32}
              pattern="[A-Za-z0-9_\-]+"
            />
          </div>
          {mode === 'register' && (
            <div className="field">
              <label>显示昵称（可选）</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={48} placeholder="群里怎么称呼你" />
            </div>
          )}
          <div className="field">
            <label>密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              maxLength={128}
            />
          </div>
          <button className="btn primary block" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并进入'}
          </button>
          {err && <div className="form-err">{err}</div>}
        </form>
        <div className="swap">
          {mode === 'login' ? (
            <>
              还没有账号？<button onClick={() => setMode('register')}>立即注册</button>
            </>
          ) : (
            <>
              已有账号？<button onClick={() => setMode('login')}>直接登录</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
