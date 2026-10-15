import { useState } from 'react';
import { Database, ArrowRight, LockKey, User } from '@phosphor-icons/react';
import { useAuth } from './AuthProvider.jsx';

/** 注册和登录共享表单；不向浏览器暴露上游服务凭据。 */
export function LoginPage() {
  const auth = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const register = mode === 'register';
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await auth.authenticate(mode, username.trim(), password); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  function changeMode() { setMode(register ? 'login' : 'register'); setPassword(''); setError(''); }
  return <main className="auth-page">
    <section className="auth-intro"><a className="auth-brand" href="/"><Database weight="duotone" size={28} />MemoryOS</a><div><span className="auth-eyebrow">记忆，让每一次对话延续</span><h1>从认识你开始，<br />记住每一个重要时刻。</h1><p>一个账号，连接宠物伙伴与记忆助手。<br />你确认的记忆，会在下一次对话继续陪伴你。</p></div><small>你的账号拥有独立的记忆空间</small></section>
    <section className="auth-panel" aria-label={register ? '注册账号' : '登录账号'}><div className="auth-card"><span className="auth-card-icon"><LockKey size={26} /></span><h2>{register ? '创建你的账号' : '欢迎回来'}</h2><p>{register ? '注册后即可拥有专属的记忆空间。' : '登录后，继续与你的记忆伙伴对话。'}</p>
      <form onSubmit={submit}><fieldset disabled={busy}><label htmlFor="auth-username"><User size={16} />用户名</label><input id="auth-username" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" autoCapitalize="none" spellCheck={false} title="3–32 位英文字母、数字或下划线" placeholder="3–32 位字母、数字或下划线" value={username} onChange={event => setUsername(event.target.value)} /><label htmlFor="auth-password"><LockKey size={16} />密码</label><input id="auth-password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={1} maxLength={128} placeholder={register ? '输入密码' : '输入密码'} value={password} onChange={event => setPassword(event.target.value)} /></fieldset>
        {(error || auth.error) && <div className="auth-error" role="alert">{error || auth.error}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? '正在处理…' : register ? '注册并登录' : '登录'}{!busy && <ArrowRight size={18} />}</button>
      </form><p className="auth-switch">{register ? '已有账号？' : '还没有账号？'}<button type="button" disabled={busy} onClick={changeMode}>{register ? '返回登录' : '创建账号'}</button></p>{auth.error && <button type="button" className="auth-recheck" onClick={auth.refresh}>重新检查登录状态</button>}<div className="auth-note"><LockKey size={15} />记忆服务由系统自动连接，无需填写连接信息。</div>
    </div></section>
  </main>;
}
