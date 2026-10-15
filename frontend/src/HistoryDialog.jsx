import { useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import { api } from './api.js';

/** 原生模态框管理焦点与 Escape；会话列表按页读取，避免加载大量历史。 */
export function HistoryDialog({ onClose, onChoose, surface = 'pet' }) {
  const dialog = useRef(null);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    api(`/sessions?${surface === 'memory' ? 'surface=memory&' : ''}page=${page}&limit=20`).then(data => {
      if (active) { setItems(data.items || []); setPages(data.total_pages || 1); }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, surface]);
  return <dialog className="history-dialog" ref={dialog} aria-labelledby="history-title" onCancel={onClose}>
    <div className="dialog-title"><h2 id="history-title">历史对话</h2><button aria-label="关闭历史对话" className="icon-button" onClick={onClose}><X /></button></div>
    {loading ? <p className="muted" role="status">正在读取历史对话…</p> : items.length ? items.map(item => <button className="history-item" key={item.id} onClick={async () => { setLoading(true); setError(''); try { await onChoose(item); } catch (error) { setError(error.message); } finally { setLoading(false); } }}><span>{item.title || (item.mode === 'training' ? '训练对话' : '正式对话')}</span><time>{new Date(item.created_at).toLocaleDateString('zh-CN')}</time></button>) : <p className="muted">还没有历史对话。</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {pages > 1 && <div className="memory-pagination"><button disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {pages} 页</span><button disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>下一页</button></div>}
  </dialog>;
}
