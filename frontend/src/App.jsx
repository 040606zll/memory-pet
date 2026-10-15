import { useCallback, useEffect, useRef, useState } from 'react';
import { PawPrint, Link, X, GraduationCap, ChatCircleDots, PencilSimple, User, Heart, PaperPlaneTilt, Note, CheckCircle, BookOpen, DotsThree, ArrowClockwise, Trash } from '@phosphor-icons/react';
import { api, patch, post } from './api.js';
import { newRequestId } from './requestId.js';
import { AccountControls, useAuth } from './AuthProvider.jsx';
import { HistoryDialog } from './HistoryDialog.jsx';
import { ConnectionDialog } from './ConnectionDialog.jsx';
import { RobotDogAvatar } from './RobotDog.jsx';
import { PetStage } from './pet3d/PetStage.jsx';
import { previewMessages } from './preview.js';
import { petNameKey, readPetName, savePetName, validPetName } from './petName.js';

const initialPreview = new URLSearchParams(window.location.search).get('preview');
const formatTime = timestamp => timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const MODE_TITLE = { training: '教小忆更懂你', chat: '和小忆聊聊' };

export function App() {
  const userId = useAuth()?.user?.id;
  const nameKey = petNameKey(userId);
  const [petSpeech, setPetSpeech] = useState(null);
  const petSpeechTimer = useRef(null);
  const showPetSpeech = useCallback((text, duration = 3500) => {
    clearTimeout(petSpeechTimer.current);
    setPetSpeech(text);
    petSpeechTimer.current = setTimeout(() => setPetSpeech(null), duration);
  }, []);
  useEffect(() => () => clearTimeout(petSpeechTimer.current), []);
  const [mode, setMode] = useState(initialPreview === 'chat' ? 'chat' : 'training');
  const [preview, setPreview] = useState(['training', 'chat'].includes(initialPreview));
  const [status, setStatus] = useState(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [totalMemories, setTotalMemories] = useState(0);
  const [messagePage, setMessagePage] = useState(1);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastRequest, setLastRequest] = useState(null);
  const [actions, setActions] = useState([]);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [name, setName] = useState(() => readPetName(nameKey));
  const nameRevision = useRef(0);
  const [renaming, setRenaming] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const requestLock = useRef(false);
  const activeSessionRef = useRef(null);
  const memoryRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const scrollKeepRef = useRef(null);
  const modeViewsRef = useRef({});
  const displayedMessages = preview ? previewMessages(mode) : messages;
  const candidates = displayedMessages.flatMap(m => m.candidates || []).filter(c => c.status === 'pending');
  const learned = preview ? 2 : totalMemories;

  useEffect(() => {
    api('/status').then(setStatus).catch(e => setError(e.message));
    return () => { abortRef.current?.abort(); window.speechSynthesis?.cancel(); };
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = event => setReducedMotion(event.matches);
    query.addEventListener('change', change); return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (preview || !scrollRef.current) return;
    if (scrollKeepRef.current) {
      const previous = scrollKeepRef.current;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight - previous.height + previous.top;
      scrollKeepRef.current = null;
    } else scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reducedMotion ? 'instant' : 'smooth' });
  }, [messages, busy, preview, reducedMotion]);

  const loadMemories = useCallback(async (id, page = 1, q = '') => {
    const requestNumber = ++memoryRequestRef.current;
    const data = await api(`/sessions/${id}/memories?page=${page}&limit=20&q=${encodeURIComponent(q)}`);
    if (activeSessionRef.current !== id || memoryRequestRef.current !== requestNumber) return;
    setTotalMemories(data.total);
  }, []);

  async function ensureSession() {
    if (session) return session;
    const created = await post('/sessions', { mode });
    activeSessionRef.current = created.id; setSession(created);
    return created;
  }

  // 标签切换保留各自会话与未完成输入，不能通过修改同一会话的模式混用历史。
  function rememberMode() {
    modeViewsRef.current[mode] = { session, messages, draft, lastRequest, error, messagePage, totalMemories };
  }
  function changeMode(next) {
    if (next === mode || busy || candidateBusy || requestLock.current) return;
    rememberMode();
    const view = modeViewsRef.current[next];
    historyRequestRef.current++; memoryRequestRef.current++;
    activeSessionRef.current = view?.session?.id || null;
    scrollKeepRef.current = null;
    setSession(view?.session || null); setMessages(view?.messages || []);
    setDraft(view?.draft || ''); setLastRequest(view?.lastRequest || null); setError(view?.error || '');
    setMessagePage(view?.messagePage || 1); setTotalMemories(view?.totalMemories || 0);
    setEarlierBusy(false); setEditing(false); setEditValues({}); setActions([]);
    window.speechSynthesis?.cancel();
    setMode(next);
  }

  async function send(retry = null) {
    if (requestLock.current || candidateBusy) return;
    if (preview) { setError('当前是静态原型预览，请退出预览并连接服务后开始对话。'); return; }
    const content = (retry?.content || draft).trim();
    if (!content) return;
    if (!status?.connected) { setConnectionOpen(true); return; }
    requestLock.current = true; setBusy(true); setError('');
    const controller = new AbortController(); abortRef.current = controller;
    const startingNameRevision = nameRevision.current;
    try {
      // 编号生成也可能失败，必须释放等待状态并保留尚未提交的草稿。
      const request = retry || { content, pet_name: name, request_id: newRequestId() };
      setLastRequest(request); setDraft('');
      setMessages(previous => [...previous.filter(message => message.id !== `pending-${request.request_id}`), { id: `pending-${request.request_id}`, role: 'user', content: request.content, created_at: new Date().toISOString(), pending: true }]);
      const currentSession = await ensureSession();
      const result = await post(`/sessions/${currentSession.id}/chat`, request, controller.signal);
      // 只采用后端已解析的名字；用户在等待期间手动改名时，旧响应不能覆盖新选择。
      const nextName = validPetName(result.assistant_message.pet_name);
      if (nextName && startingNameRevision === nameRevision.current) { setName(nextName); savePetName(nameKey, nextName); }
      setMessages(previous => [...previous.filter(m => ![`pending-${request.request_id}`, result.user_message.id, result.assistant_message.id].includes(m.id)), result.user_message, result.assistant_message]);
      setActions(result.assistant_message.actions || []);
      setLastRequest(null);
      if (voiceEnabled && window.speechSynthesis) {
        const utterance = new SpeechSynthesisUtterance(result.assistant_message.content); utterance.lang = 'zh-CN'; window.speechSynthesis.speak(utterance);
      }
      await loadMemories(currentSession.id);
    } catch (e) {
      setError(e.name === 'AbortError' ? '本次对话已取消。你可以重试这条消息。' : e.message);
    } finally {
      requestLock.current = false; setBusy(false); abortRef.current = null; textareaRef.current?.focus();
    }
  }

  function updateCandidate(updated, expectedSessionId) {
    if (activeSessionRef.current !== expectedSessionId) return;
    setMessages(previous => previous.map(m => ({ ...m, candidates: m.candidates?.map(c => c.id === updated.id ? updated : c) })));
  }
  async function rejectCandidate(id) {
    if (preview) { setError('预览中的记忆不能写入服务。'); return; }
    const candidateSessionId = session.id;
    setCandidateBusy(true); setError('');
    try { updateCandidate(await patch(`/sessions/${candidateSessionId}/candidates/${id}`, { status: 'rejected' }), candidateSessionId); }
    catch (e) { setError(e.message); }
    finally { setCandidateBusy(false); }
  }
  async function saveCandidates() {
    if (preview) { setError('预览中的记忆不能写入服务。'); return; }
    if (candidates.some(candidate => Object.hasOwn(editValues, candidate.id) && !editValues[candidate.id].trim())) { setError('记忆内容不能为空，请补充内容或拒绝这条记忆。'); return; }
    const candidateSessionId = session.id;
    setCandidateBusy(true); setError('');
    try {
      for (const candidate of candidates) if (editValues[candidate.id]?.trim() && editValues[candidate.id].trim() !== candidate.content) updateCandidate(await patch(`/sessions/${candidateSessionId}/candidates/${candidate.id}`, { content: editValues[candidate.id].trim() }), candidateSessionId);
      setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setCandidateBusy(false); }
  }
  async function confirmCandidates() {
    if (preview) { setError('预览中的记忆不能写入服务。'); return; }
    const candidateSessionId = session.id;
    setCandidateBusy(true); setError('');
    try {
      for (const candidate of candidates) updateCandidate(await post(`/sessions/${candidateSessionId}/memories/confirm`, { candidate_id: candidate.id }), candidateSessionId);
      await loadMemories(candidateSessionId); if (activeSessionRef.current !== candidateSessionId) return; setActions([{ name: 'happy', trigger: 'emotion', duration_ms: 2400 }]);
    } catch (e) { setError(e.message); }
    finally { setCandidateBusy(false); }
  }

  async function connected() {
    modeViewsRef.current = {};
    setDraft(''); setEditing(false); setEditValues({}); setActions([]); scrollKeepRef.current = null;
    historyRequestRef.current++; setMessagePage(1); setEarlierBusy(false);
    setPreview(false); setSession(null); activeSessionRef.current = null; setMessages([]); setTotalMemories(0); setError(''); setLastRequest(null);
    try { setStatus(await api('/status')); } catch (e) { setError(e.message); }
  }
  function openHistory() { setMenuOpen(false); setHistoryOpen(true); }
  async function openSession(item) {
    if (busy || candidateBusy) return;
    const requestVersion = ++historyRequestRef.current;
    try {
      // 后端按创建时间升序分页，先查询总页数再获取最新页，不能只读最早的 100 条。
      const firstPage = await api(`/sessions/${item.id}/messages?page=1&limit=100`);
      const lastPage = Math.max(1, firstPage.total_pages || 1);
      const data = lastPage > 1 ? await api(`/sessions/${item.id}/messages?page=${lastPage}&limit=100`) : firstPage;
      if (requestVersion !== historyRequestRef.current) return;
      rememberMode();
      setDraft(''); setError(''); setEditing(false); setEditValues({}); setActions([]); scrollKeepRef.current = null;
      setPreview(false); setSession(item); activeSessionRef.current = item.id; setMode(item.mode); setMessages(data.items); setMessagePage(lastPage); setHistoryOpen(false); setLastRequest(null);
      await loadMemories(item.id);
    } catch (e) { if (requestVersion === historyRequestRef.current) setError(e.message); }
  }
  async function loadEarlier() {
    if (!session || messagePage <= 1 || earlierBusy || busy || candidateBusy) return;
    const sessionId = session.id;
    const viewVersion = historyRequestRef.current;
    const previousPage = messagePage - 1;
    setEarlierBusy(true); setError('');
    try {
      const data = await api(`/sessions/${sessionId}/messages?page=${previousPage}&limit=100`);
      if (activeSessionRef.current !== sessionId || historyRequestRef.current !== viewVersion) return;
      const previousIds = new Set(data.items.map(message => message.id));
      scrollKeepRef.current = { height: scrollRef.current.scrollHeight, top: scrollRef.current.scrollTop };
      setMessages(previous => [...data.items, ...previous.filter(message => !previousIds.has(message.id))]);
      setMessagePage(previousPage);
    } catch (e) { if (activeSessionRef.current === sessionId && historyRequestRef.current === viewVersion) setError(e.message); }
    finally { if (historyRequestRef.current === viewVersion) setEarlierBusy(false); }
  }
  function closeHistory() { historyRequestRef.current++; setHistoryOpen(false); }
  function startNewSession() { setDraft(''); setEditing(false); setEditValues({}); setActions([]); scrollKeepRef.current = null; historyRequestRef.current++; setMessagePage(1); setEarlierBusy(false); setSession(null); activeSessionRef.current = null; setMessages([]); setTotalMemories(0); setMenuOpen(false); setError(''); setLastRequest(null); }
  function togglePreview() { setPreview(!preview); setMenuOpen(false); setError(''); }
  function rename(value) { const next = validPetName(Array.from(value.trim()).slice(0, 12).join('')) || '小忆'; nameRevision.current++; setName(next); savePetName(nameKey, next); setRenaming(false); }
  const lastAssistant = messages.findLast(message => message.role === 'assistant');
  const speech = petSpeech && !preview && !busy ? petSpeech : preview ? mode === 'training' ? '我在听，慢慢说。' : '我陪你歇一会儿。' : busy ? '我在认真听你说。' : lastAssistant ? lastAssistant.content.slice(0, 16) : messages.length ? '我在听，慢慢说。' : `你好，我是${name}。`;
  const modeTitle = MODE_TITLE[mode].replaceAll('小忆', name);

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><PawPrint weight="fill" /></span><span>MemoryOS · 宠物伙伴</span></div>
      <div className="header-controls">
        <AccountControls />
        <a className="surface-link" href="/memory"><ChatCircleDots weight="bold" /><span>记忆对话</span></a>
        <span className={`connection-status ${status?.connected || preview ? 'online' : ''}`}><span className="status-dot" />{preview ? '原型预览' : status?.connected ? '记忆已连接' : '尚未连接'}</span>
        <button className="connect-button" onClick={() => setConnectionOpen(true)} disabled={busy || candidateBusy}><Link weight="bold" />记忆服务</button>
        <div className="menu-wrap"><button className="close-button" aria-label={preview ? '退出原型预览' : '打开菜单'} onClick={() => preview ? setPreview(false) : setMenuOpen(!menuOpen)}>{preview ? <X weight="bold" /> : <DotsThree weight="bold" />}</button>
          {menuOpen && <div className="app-menu"><button onClick={togglePreview}>查看原型预览</button><button onClick={startNewSession} disabled={busy || candidateBusy}>开启新对话</button><button onClick={openHistory} disabled={busy || candidateBusy}>历史对话</button><button onClick={() => { setPaused(!paused); setMenuOpen(false); }}>{paused ? '继续陪伴' : '暂停宠物动作'}</button><button onClick={() => { setVoiceEnabled(!voiceEnabled); setMenuOpen(false); }}>{voiceEnabled ? '关闭' : '开启'}语音朗读</button></div>}
        </div>
      </div>
    </header>
    <section className="experience" aria-label="机器狗宠物对话">
      <section className="pet-room" aria-label={`${name}的房间`}>
        <div className="pet-profile"><RobotDogAvatar name={name} /><div className="pet-profile-info"><div className="pet-name-row">{renaming ? <input autoFocus className="name-input" defaultValue={name} maxLength={12} aria-label="宠物名字" onBlur={e => rename(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename(e.target.value); }} /> : <><strong>{name}</strong><button aria-label="修改宠物名字" className="rename-button" onClick={() => setRenaming(true)}><PencilSimple weight="bold" /></button></>}<span className="level">Lv.{preview ? 3 : Math.floor(learned / 5) + 1}</span></div><div className="bond">亲密度 <b>{preview ? 60 : Math.min(100, learned * 5)}</b> / 100</div><div className="bond-track"><span style={{ width: `${preview ? 60 : Math.min(100, learned * 5)}%` }} /></div></div></div>
        <div className="pet-speech" aria-live="polite" title={speech}><span className="pet-speech-copy">{speech}</span><span className="heart-sticker"><Heart weight="fill" /></span></div>
        <PetStage name={name} actions={actions} preview={preview} mode={mode} reducedMotion={reducedMotion || paused} onSay={showPetSpeech} userId={userId} />
      </section>
      <section className={`conversation ${mode} ${preview ? "prototype-preview" : ""}`} aria-label={modeTitle}>
        <div role="tablist" className="mode-tabs" aria-label="选择对话模式"><button role="tab" aria-selected={mode === 'training'} id="tab-training" aria-controls="conversation-panel" className={mode === 'training' ? 'selected' : ''} onClick={() => changeMode('training')} disabled={busy || candidateBusy}><GraduationCap weight="fill" />训练</button><button role="tab" aria-selected={mode === 'chat'} id="tab-chat" aria-controls="conversation-panel" className={mode === 'chat' ? 'selected' : ''} onClick={() => changeMode('chat')} disabled={busy || candidateBusy}><ChatCircleDots weight="fill" />正式对话</button></div>
        <div className="conversation-heading"><h1>{modeTitle}</h1><p>{mode === 'training' ? '通过聊天教我，确认后记住。' : '我记得你的偏好，也会一直陪着你。'}</p></div>
        <div className="conversation-content" ref={scrollRef} id="conversation-panel" role="tabpanel" aria-labelledby={`tab-${mode}`}>
          {!displayedMessages.length && <div className="empty-chat"><RobotDogAvatar name={name} /><h2>{mode === 'training' ? '从了解你开始' : '今天想和我聊什么？'}</h2><p>{mode === 'training' ? '告诉我你的偏好，或纠正我的回答。\n你确认的内容才会成为我们的长期记忆。' : '聊聊今天的事，试试让我摇尾巴或眨眨眼。\n我会带着已确认的记忆陪你聊天。'}</p>{!status?.connected && <button className="secondary" onClick={() => setConnectionOpen(true)}>检查记忆服务，开始聊天</button>}</div>}
          {!preview && messagePage > 1 && <button className="earlier-messages" disabled={earlierBusy || busy || candidateBusy} onClick={loadEarlier}>{earlierBusy ? "正在读取历史…" : "查看更早的消息"}</button>}
          <div className="messages" aria-live="polite" aria-relevant="additions text">{displayedMessages.map(message => <div key={message.id} className={`message-row ${message.role}`}>
            {message.role === 'assistant' && <RobotDogAvatar name={name} />}
            <div className="message-body"><div className="message-bubble">{message.content}</div><div className="message-meta"><time>{formatTime(message.created_at)}</time>{message.pending && <span className="pending-label">{busy ? "正在发送" : "尚未完成"}</span>}{message.role === 'assistant' && message.memories?.map(memory => <span key={memory.id} className="memory-reference" title={memory.source || '来自记忆服务'}><BookOpen weight="bold" />用到记忆：{memory.content}</span>)}</div></div>
            {message.role === 'user' && <span className="user-avatar"><User weight="fill" /></span>}
          </div>)}</div>
          {busy && <div className="thinking" role="status"><RobotDogAvatar name={name} /><span>{name}正在想一想<span className="thinking-dots">…</span></span></div>}
          {candidates.length > 0 && mode === 'training' && <section className="memory-card"><div className="memory-card-heading"><span className="memory-card-icon"><ChatCircleDots weight="fill" /></span><h2>待确认的记忆</h2></div><div className="memory-items">{candidates.map(candidate => <div className="memory-item" key={candidate.id}><Note weight="bold" />{editing ? <input aria-label="修改记忆内容" value={editValues[candidate.id] ?? candidate.content} onChange={e => setEditValues({ ...editValues, [candidate.id]: e.target.value })} maxLength={2000} /> : <span>{candidate.content}</span>}{!preview && <button className="reject-button" aria-label={`拒绝记忆：${candidate.content}`} onClick={() => rejectCandidate(candidate.id)} disabled={candidateBusy}><Trash /></button>}</div>)}</div><div className="memory-buttons">{editing ? <><button className="primary" onClick={saveCandidates} disabled={candidateBusy}>保存修改</button><button className="secondary" onClick={() => setEditing(false)} disabled={candidateBusy}>取消</button></> : <><button className="primary" onClick={confirmCandidates} disabled={candidateBusy || busy}>{candidateBusy ? '正在记住…' : '确认记住'}</button><button className="secondary" onClick={() => { setEditing(true); setEditValues({}); }} disabled={candidateBusy}>修改</button></>}</div></section>}
          {mode === 'training' && (learned > 0 || candidates.length > 0) && <p className="learned-count"><CheckCircle weight="fill" />已学会 {learned} 条偏好</p>}

        </div>
        {error && <div className="error-banner" role="alert"><span>{error}</span>{lastRequest && !busy && <button onClick={() => send(lastRequest)}><ArrowClockwise />重试</button>}<button aria-label="关闭错误提示" onClick={() => setError('')}><X /></button></div>}
        <form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><textarea ref={textareaRef} aria-label={mode === 'training' ? '训练消息' : '对话消息'} rows={1} value={draft} onChange={e => setDraft(e.target.value)} maxLength={4096} placeholder={mode === 'training' ? `告诉${name}你的偏好，或纠正它的回答…` : `和${name}聊聊今天的事…`} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} disabled={busy || candidateBusy} />{busy ? <button className="send-button cancel" aria-label="取消本次对话" type="button" onClick={() => abortRef.current?.abort()}><X weight="bold" /></button> : <button className="send-button" aria-label="发送消息" disabled={candidateBusy || !draft.trim()}><PaperPlaneTilt weight="fill" /></button>}</form>
      </section>
    </section>
    {connectionOpen && <ConnectionDialog status={status} onClose={() => setConnectionOpen(false)} onConnected={connected} />}
    {historyOpen && <HistoryDialog onClose={closeHistory} onChoose={openSession} />}
  </main>;
}
