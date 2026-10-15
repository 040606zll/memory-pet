import { useEffect, useRef, useState } from 'react';
import { X, Link } from '@phosphor-icons/react';
import { post } from './api.js';

/** 连接参数由服务端管理；此处只展示当前账号状态并提供重试。 */
export function ConnectionDialog({ status, onClose, onConnected, title = '记忆服务', description = '当前账号自动关联独立的 MemoryOS 用户，无需填写连接信息。' }) {
  const dialog = useRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const result = await post('/connection', {});
      await onConnected(result); onClose();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} onCancel={onClose} className="connection-dialog" aria-labelledby="connection-title">
    <div className="dialog-title"><h2 id="connection-title"><Link weight="bold" /> {title}</h2><button className="icon-button" aria-label="关闭连接设置" onClick={onClose}><X /></button></div>
    <p className="muted">{description}</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy}><legend>服务状态</legend>
        <p>记忆服务：{status?.memory_validated || status?.connected ? '已连接' : '等待连接'}</p>
        <p>对话模型：{status?.llm?.configured ? '已配置' : '等待配置'}</p>
        {status?.memory_error && <p className="error-message" role="alert">{status.memory_error}</p>}
        <p className="muted small">系统会自动建立并复用你的专属记忆空间。服务不可用时可重试；如持续失败，请联系管理员检查服务配置。</p>
      </fieldset>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="secondary" onClick={onClose} disabled={busy}>关闭</button><button className="primary" disabled={busy}>{busy ? '正在连接…' : '重试连接'}</button></div>
    </form>
  </dialog>;
}
