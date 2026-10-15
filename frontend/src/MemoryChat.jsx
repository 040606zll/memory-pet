import { useState } from 'react';
import { AccountControls } from './AuthProvider.jsx';
import { ArrowClockwise, ArrowLeft, ArrowRight, BookOpen, ChatText, Database, Link, List, PaperPlaneTilt, Plus, Robot, X } from '@phosphor-icons/react';
import { ConnectionDialog } from './ConnectionDialog.jsx';
import { MemoryCandidate, MemoryDrawer, MemoryEvidence, memoryTime } from './MemoryChatParts.jsx';
import { useMemoryChat } from './MemoryChatState.js';
import './memoryChat.css';

const examples = {
  training: ['我希望回答先给结论，再解释原因。', '我正在学习 Python，示例请尽量简单。'],
  chat: ['我之前说过，希望你如何组织回答？', '我正在学习什么？示例应该是什么风格？'],
};
const progressLabel = { chat: '正在召回记忆并生成回答', confirm: '正在确认并写入记忆', candidate: '正在更新候选', session: '正在创建新会话', mode: '正在切换模式', history: '正在读取历史会话', earlier: '正在读取更早的消息', memories: '正在读取长期记忆' };

/** 普通助手记忆验证入口，所有候选、引用和会话均来自当前服务响应。 */
export function MemoryChat() {
  const chat = useMemoryChat();
  const [mobileHistory, setMobileHistory] = useState(false);
  const connected = Boolean(chat.status?.connected);
  const canCancel = chat.busy && ['chat', 'confirm', 'history', 'session'].includes(chat.operation);
  return <main className="mc-app">
    <aside className={`mc-sidebar ${mobileHistory ? 'mc-mobile-history-open' : ''}`}>
      <a className="mc-brand" href="/memory"><span><Database weight="duotone" size={24} /></span><div><strong>MemoryOS</strong><small>记忆对话</small></div></a>
      <div className="mc-sidebar-actions">
        <button className="mc-new-chat" disabled={chat.busy} onClick={() => chat.createSession('training')}><Plus size={17} />新写入会话</button>
        <button className="mc-recall-new" disabled={chat.busy} onClick={() => chat.createSession('chat')}><ArrowClockwise size={17} />新会话测试召回</button>
      </div>
      <div className="mc-history-heading"><span>普通助手会话</span><button className="mc-icon-button mc-mobile-toggle" aria-label="展开会话列表" aria-expanded={mobileHistory} onClick={() => setMobileHistory(!mobileHistory)}><List /></button></div>
      <div className="mc-session-list" aria-label="记忆会话列表">
        {!connected ? <p className="mc-sidebar-empty">连接服务后查看会话</p> : chat.sessionsLoading ? <p role="status" className="mc-sidebar-empty">读取会话中…</p> : chat.sessions.length ? chat.sessions.map(session => <button key={session.id} disabled={chat.busy} className={chat.session?.id === session.id ? 'mc-session-selected' : ''} onClick={async () => { await chat.openSession(session); setMobileHistory(false); }}>
          <ChatText size={17} /><div><strong>{session.title || (session.mode === 'training' ? '记忆写入对话' : '记忆召回验证')}</strong><small>{session.mode === 'training' ? '写入' : '召回'} · {new Date(session.created_at).toLocaleDateString('zh-CN')}</small></div>
        </button>) : <p className="mc-sidebar-empty">还没有普通助手会话。<br />从一段真实对话开始。</p>}
      </div>
      {connected && chat.sessionPages > 1 && <div className="mc-pagination mc-session-pagination"><button aria-label="会话上一页" disabled={chat.busy || chat.sessionsLoading || chat.sessionPage <= 1} onClick={() => chat.refreshSessions(chat.sessionPage - 1)}><ArrowLeft /></button><span>{chat.sessionPage} / {chat.sessionPages}</span><button aria-label="会话下一页" disabled={chat.busy || chat.sessionsLoading || chat.sessionPage >= chat.sessionPages} onClick={() => chat.refreshSessions(chat.sessionPage + 1)}><ArrowRight /></button></div>}
      <div className="mc-sidebar-bottom">
        <AccountControls />
        <button disabled={chat.busy} onClick={() => chat.viewMemories()}><BookOpen size={18} />查看长期记忆</button>
        <button disabled={chat.busy} onClick={() => chat.setConnectionOpen(true)}><Link size={18} />记忆服务</button>
        <a href="/">返回宠物体验<ArrowRight size={14} /></a>
        <p><span className={connected ? 'mc-dot mc-connected' : 'mc-dot'} />{connected ? '服务已验证连接' : '尚未连接服务'}</p>
      </div>
    </aside>
    <section className="mc-main" aria-label="普通助手对话">
      <header className="mc-topbar"><div><h1>和记忆助手对话</h1><p>真实写入，跨会话验证召回。</p></div><button className="mc-button mc-connect" onClick={() => chat.setConnectionOpen(true)} disabled={chat.busy}><Link size={16} />记忆服务</button></header>
      <div className="mc-conversation">
        <div className="mc-mode-header">
          <div className="mc-modes" role="tablist" aria-label="记忆对话模式">
            <button role="tab" id="mc-training-tab" aria-selected={chat.mode === 'training'} aria-controls="mc-dialogue-panel" disabled={chat.busy} onClick={() => chat.changeMode('training')}><Database size={17} />写入记忆</button>
            <button role="tab" id="mc-chat-tab" aria-selected={chat.mode === 'chat'} aria-controls="mc-dialogue-panel" disabled={chat.busy} onClick={() => chat.changeMode('chat')}><BookOpen size={17} />召回记忆</button>
          </div>
          <span className="mc-current-session">{chat.session ? '已建立独立会话' : '尚未开始对话'}</span>
        </div>
        <p className="mc-mode-explanation">{chat.mode === 'training' ? '对话会生成待确认的记忆；只有你确认后，才会写入长期记忆。' : '回答会召回已写入的记忆。使用左侧“新会话测试召回”可排除当前聊天历史影响。'}</p>
        <div className="mc-message-scroll" ref={chat.scrollRef} role="tabpanel" id="mc-dialogue-panel" aria-labelledby={chat.mode === 'training' ? 'mc-training-tab' : 'mc-chat-tab'}>
          {!chat.messages.length && <div className="mc-empty"><span><ChatText weight="duotone" size={34} /></span><h2>{chat.mode === 'training' ? '让助手了解需要记住的内容' : '验证助手能否记起已写入的信息'}</h2><p>{chat.mode === 'training' ? '告诉助手一条偏好或长期有效的信息。\n检查候选内容，再确认写入。' : '这是普通助手对话，不带宠物角色。\n提出一个需要过去信息才能回答的问题。'}</p><div className="mc-examples">{examples[chat.mode].map(example => <button key={example} disabled={chat.busy} onClick={() => { chat.setDraft(example); chat.inputRef.current?.focus(); }}>{example}<ArrowRight size={14} /></button>)}</div><small>示例只填入输入框，不自动发送。</small></div>}
          {chat.messagePage > 1 && <button className="mc-earlier" disabled={chat.busy} onClick={chat.earlier}>查看更早的消息</button>}
          <div className="mc-messages" aria-live="polite" aria-relevant="additions text">{chat.messages.map(message => <article key={message.id} className={`mc-message mc-${message.role}`}>
            <div className="mc-message-label">{message.role === 'assistant' && <Robot size={18} />}<strong>{message.role === 'user' ? '你' : '记忆助手'}</strong><time>{memoryTime(message.created_at)}</time>{message.pending && <span>{chat.busy ? '发送中' : '尚未完成'}</span>}</div>
            <div className="mc-message-content">{message.content}</div>
            {message.role === 'assistant' && <>
              <MemoryEvidence memories={message.memories} />
              <div className="mc-message-candidates">{message.candidates?.map(candidate => <MemoryCandidate key={candidate.id} candidate={candidate} busy={chat.busy} working={chat.writingId === candidate.id} onEdit={content => chat.candidateMutation(candidate, content)} onReject={() => chat.candidateMutation(candidate, '', true)} onConfirm={() => chat.confirm(candidate)} onView={query => chat.viewMemories(query)} />)}</div>
            </>}
          </article>)}</div>
          {chat.busy && <div className="mc-progress" role="status"><span />{progressLabel[chat.operation]}…</div>}
        </div>
        {chat.error && <div className="mc-error" role="alert"><span>{chat.error}</span>{chat.lastRequest && !chat.busy && <button onClick={() => chat.send(chat.lastRequest)}><ArrowClockwise size={15} />重试消息</button>}<button aria-label="关闭错误提示" onClick={() => chat.setError('')}><X size={16} /></button></div>}
        <form className="mc-composer" onSubmit={event => { event.preventDefault(); chat.send(); }}>
          <textarea ref={chat.inputRef} aria-label="普通助手消息" rows={2} maxLength={4096} placeholder={chat.mode === 'training' ? '告诉助手需要记住的信息…' : '询问一个需要长期记忆才能回答的问题…'} value={chat.draft} disabled={chat.busy} onChange={event => chat.setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); chat.send(); } }} />
          <div className="mc-composer-footer"><span>Enter 发送 · Shift + Enter 换行</span>{canCancel ? <button type="button" className="mc-button" onClick={chat.cancel}><X size={15} />取消请求</button> : <button className="mc-button mc-primary" disabled={chat.busy || !chat.draft.trim()}><PaperPlaneTilt size={16} />发送</button>}</div>
        </form>
      </div>
      <p className="mc-page-note">记忆记录由当前 MemoryOS 服务管理；本页不会将未确认候选当作长期记忆。</p>
    </section>
    {chat.memoryOpen && <MemoryDrawer chat={chat} />}
    {chat.connectionOpen && <ConnectionDialog status={chat.status} onClose={() => chat.setConnectionOpen(false)} onConnected={chat.connected} title="记忆助手服务" description="当前账号自动关联独立的 MemoryOS 用户，服务由系统统一连接。" />}
  </main>;
}
export default MemoryChat;
