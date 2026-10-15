import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, invalidateApiSession, onSessionInvalidated, post, setApiSession } from './api.js';
import { LoginPage } from './LoginPage.jsx';
import './auth.css';

const AuthContext = createContext(null);
const SESSION_NOTICE = 'memory-pet-session-change';
export const useAuth = () => useContext(AuthContext);

/** 不持久化凭据；通知其他标签重新检查 HttpOnly Cookie 对应账号。 */
function notifyTabs() {
  try { localStorage.setItem(SESSION_NOTICE, crypto.randomUUID()); } catch { /* 禁用存储时由聚焦校验兜底。 */ }
}
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const version = useRef(0);
  const mounted = useRef(false);
  const invalidate = useCallback(() => {
    version.current++;
    setUser(null); setChecking(false); setError('');
  }, []);
  const refresh = useCallback(async () => {
    // 检查期间隔离旧请求并隐藏业务界面；同一账号校验通过后保留未发送草稿。
    setApiSession();
    const activeRequest = ++version.current;
    setChecking(true); setError('');
    try {
      const data = await api('/auth/me');
      if (!mounted.current || activeRequest !== version.current) return;
      setApiSession(data.csrf_token); setUser(data.user);
    } catch (e) {
      if (!mounted.current || activeRequest !== version.current) return;
      setUser(null); if (e.status !== 401) setError(e.message);
    } finally {
      if (mounted.current && activeRequest === version.current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onSessionInvalidated(invalidate);
    refresh();
    const storage = event => { if (event.key === SESSION_NOTICE) refresh(); };
    const focus = () => refresh();
    window.addEventListener('storage', storage);
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false; version.current++;
      unsubscribe(); window.removeEventListener('storage', storage); window.removeEventListener('focus', focus);
      setApiSession();
    };
  }, [invalidate, refresh]);
  async function authenticate(mode, username, password) {
    const request = ++version.current;
    const data = await post(`/auth/${mode}`, { username, password });
    if (!mounted.current || request !== version.current) return;
    setApiSession(data.csrf_token); setUser(data.user); setError(''); setChecking(false); notifyTabs();
  }
  async function logout() {
    const request = ++version.current;
    try {
      await post('/auth/logout', {});
      if (!mounted.current || request !== version.current) return;
      invalidateApiSession(); notifyTabs();
    } catch (e) {
      if (!mounted.current || request !== version.current) return;
      if (e.status === 401) { invalidateApiSession(); notifyTabs(); }
      else setError(e.message);
    }
  }
  return <AuthContext.Provider value={{ user, checking, error, authenticate, logout, refresh }}>{children}</AuthContext.Provider>;
}

/** 两个页面共用唯一登录入口，账号变化时重新创建完整业务组件树。 */
export function AuthGate({ children }) {
  const auth = useAuth();
  return <>
    {auth.checking && <main className="auth-loading" role="status">正在验证登录状态…</main>}
    {auth.user ? <div className="authenticated-app" hidden={auth.checking} inert={auth.checking} key={auth.user.id}>{children}</div> : !auth.checking && <LoginPage />}
  </>;
}
export function AccountControls() {
  const auth = useAuth();
  if (!auth?.user) return null;
  return <div className="account-controls"><span title={auth.user.username}>账号：{auth.user.username}</span><button type="button" onClick={auth.logout}>退出登录</button>{auth.error && <span className="account-error" role="alert">{auth.error}</span>}</div>;
}
