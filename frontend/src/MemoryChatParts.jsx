import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle, FileText, PencilSimple, Trash, X } from '@phosphor-icons/react';

export const memoryTime = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

/** 引用默认仅显示数量，展开后才显示编号、来源和内容，避免重复证据占满对话。 */
export function MemoryEvidence({ memories = [] }) {
  const unique = [...new Map(memories.map(memory => [memory.id || memory.content, memory])).values()];
  if (!unique.length) return null;
  return <details className="mc-evidence">
    <summary><BookOpen size={15} />引用 {unique.length} 条记忆<span>查看召回证据</span></summary>
    <div className="mc-evidence-items">{unique.map(memory => <article key={memory.id || memory.content}>
      <div><code>{memory.id || '未返回编号'}</code><span>{memory.source || 'MemoryOS'}</span></div>
      <p>{memory.content}</p>
    </article>)}</div>
  </details>;
}

export function MemoryCandidate({ candidate, busy, working, onEdit, onReject, onConfirm, onView }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(candidate.content);
  useEffect(() => { if (!editing) setContent(candidate.content); }, [candidate.content, editing]);
  if (candidate.status === 'rejected') return <div className="mc-candidate-resolved">已忽略这条候选记忆</div>;
  if (candidate.status === 'confirmed' && candidate.memory_ids?.length) return <details className="mc-write-success">
    <summary><CheckCircle weight="fill" />已写入 {candidate.memory_ids.length} 条长期记忆</summary>
    <p>服务已返回记忆编号。你可以在新会话中验证召回。</p>
    <div>{candidate.memory_ids.map(id => <button key={id} onClick={() => onView(candidate.content)} disabled={busy} aria-label={`查看已写入记忆 ${id}`}><code>{id}</code><ArrowRight size={13} /></button>)}</div>
  </details>;
  return <section className="mc-candidate" aria-label="待确认记忆">
    <div className="mc-candidate-heading"><FileText size={17} /><strong>待确认记忆</strong><span>确认后才写入</span></div>
    {editing ? <textarea aria-label="修改候选内容" value={content} maxLength={2000} onChange={event => setContent(event.target.value)} disabled={busy} /> : <p>{candidate.content}</p>}
    <div className="mc-candidate-actions">{editing ? <>
      <button className="mc-button mc-primary" disabled={busy} onClick={async () => { if (await onEdit(content)) setEditing(false); }}>保存修改</button>
      <button className="mc-button" disabled={busy} onClick={() => { setContent(candidate.content); setEditing(false); }}>取消修改</button>
    </> : <>
      <button className="mc-button mc-primary" disabled={busy} onClick={onConfirm}>{working ? '处理中…' : '确认并写入'}</button>
      <button className="mc-button" disabled={busy} onClick={() => setEditing(true)}><PencilSimple size={14} />修正</button>
      <button className="mc-button mc-reject" disabled={busy} onClick={onReject}><Trash size={14} />拒绝</button>
    </>}</div>
  </section>;
}

export function MemoryDrawer({ chat }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const escape = event => { if (event.key === 'Escape') chat.setMemoryOpen(false); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); previous?.focus?.(); };
  }, [chat.setMemoryOpen]);
  const pages = Math.max(1, Math.ceil(chat.memoryTotal / 20));
  return <aside className="mc-memory-drawer" aria-label="长期记忆查看">
    <div className="mc-drawer-heading"><div><h2>长期记忆</h2><p>来自当前用户的真实 MemoryOS 记录</p></div><button ref={closeRef} className="mc-icon-button" aria-label="关闭长期记忆" onClick={() => chat.setMemoryOpen(false)}><X /></button></div>
    <form className="mc-memory-search" onSubmit={event => { event.preventDefault(); chat.memorySearch(); }}>
      <input aria-label="搜索长期记忆" placeholder="搜索记忆内容" value={chat.memoryQuery} onChange={event => chat.setMemoryQuery(event.target.value)} maxLength={200} />
      <button className="mc-button" disabled={chat.memoriesLoading}>搜索</button>
    </form>
    <div className="mc-memory-records">{chat.memoriesLoading ? <p role="status">正在读取真实记忆…</p> : chat.memories.length ? chat.memories.map(memory => <article key={memory.id} id={`memory-${memory.id}`}>
      <code>{memory.id}</code><p>{memory.content}</p><span>{memory.source || 'MemoryOS'}{memory.status ? ` · ${memory.status}` : ''}</span>
    </article>) : <div className="mc-drawer-empty"><BookOpen size={28} /><p>没有找到已写入的记忆</p><span>先在写入模式确认内容，再在这里查看。</span></div>}</div>
    <div className="mc-pagination"><button aria-label="记忆上一页" disabled={chat.memoryPage <= 1 || chat.memoriesLoading} onClick={() => chat.memorySearch(chat.memoryPage - 1)}><ArrowLeft /></button><span>{chat.memoryTotal} 条 · {chat.memoryPage} / {pages} 页</span><button aria-label="记忆下一页" disabled={chat.memoryPage >= pages || chat.memoriesLoading} onClick={() => chat.memorySearch(chat.memoryPage + 1)}><ArrowRight /></button></div>
  </aside>;
}
