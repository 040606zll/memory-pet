import { useCallback, useEffect, useRef, useState } from 'react';
import { api, patch, post } from './api.js';
import { newRequestId } from './requestId.js';

const sessionTitle = mode => mode === 'training' ? '记忆写入对话' : '记忆召回验证';
const cancelError = () => new DOMException('已取消', 'AbortError');

/** 普通助手独立编排；视图版本和会话 ID 同时保护迟到请求，登录凭据由浏览器 Cookie 交给后端。 */
export function useMemoryChat() {
  const [status, setStatus] = useState(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [mode, setMode] = useState('training');
  const [messages, setMessages] = useState([]);
  const [messagePage, setMessagePage] = useState(1);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [lastRequest, setLastRequest] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionPages, setSessionPages] = useState(1);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState([]);
  const [memoryPage, setMemoryPage] = useState(1);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [writingId, setWritingId] = useState(null);
  const epoch = useRef(0);
  const activeId = useRef(null);
  const lock = useRef(null);
  const sessionListVersion = useRef(0);
  const memoryVersion = useRef(0);
  const mounted = useRef(true);
  const scrollRef = useRef(null);
  const scrollKeep = useRef(null);
  const inputRef = useRef(null);
  const modeViews = useRef({});

  const refreshSessions = useCallback(async (page = 1) => {
    const version = ++sessionListVersion.current;
    setSessionsLoading(true);
    try {
      const data = await api(`/sessions?surface=memory&page=${page}&limit=20`);
      if (!mounted.current || version !== sessionListVersion.current) return;
      setSessions(data.items || []);
      setSessionPage(page);
      setSessionPages(Math.max(1, data.total_pages || 1));
    } catch (e) {
      if (mounted.current && version === sessionListVersion.current) setError(e.message);
    } finally {
      if (mounted.current && version === sessionListVersion.current) setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const version = epoch.current;
    api('/status').then(data => { if (mounted.current && version === epoch.current) setStatus(data); }).catch(e => { if (mounted.current && version === epoch.current) setError(e.message); });
    return () => { mounted.current = false; epoch.current++; lock.current?.controller.abort(); };
  }, []);
  useEffect(() => { if (status?.connected) refreshSessions(); }, [status, refreshSessions]);
  useEffect(() => {
    if (!scrollRef.current) return;
    if (scrollKeep.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight - scrollKeep.current.height + scrollKeep.current.top;
      scrollKeep.current = null;
    } else {
      // 空态从顶部展示完整引导；有消息时才跟随最新内容。
      scrollRef.current.scrollTo({ top: messages.length ? scrollRef.current.scrollHeight : 0, behavior: 'instant' });
    }
  }, [messages]);

  function begin(kind) {
    if (lock.current) return null;
    const token = { kind, version: epoch.current, controller: new AbortController() };
    lock.current = token; setBusy(true); setOperation(kind); setError('');
    return token;
  }
  function current(token, id = null) {
    return mounted.current && token.version === epoch.current && (!id || activeId.current === id);
  }
  function finish(token) {
    if (lock.current !== token) return;
    lock.current = null;
    if (mounted.current) { setBusy(false); setOperation(''); setWritingId(null); }
  }
  function fail(e, token) {
    if (current(token)) setError(e.name === 'AbortError' ? '请求已取消，消息仍保留，你可以重试。' : e.message);
  }
  function requireConnection() {
    if (status?.connected) return true;
    setConnectionOpen(true); return false;
  }
  async function createRemoteSession(nextMode, token) {
    const data = await post('/sessions', { surface: 'memory', mode: nextMode, title: sessionTitle(nextMode) }, token.controller.signal);
    if (token.controller.signal.aborted) throw cancelError();
    if (data.surface && data.surface !== 'memory') throw new Error('服务返回的会话类型不匹配，请更新服务后重试。');
    return data;
  }
  function installSession(data, nextMode) {
    activeId.current = data.id; setSession(data); setMode(nextMode); setMessages([]); setMessagePage(1);
    setLastRequest(null); setMemories([]); setMemoryPage(1); setMemoryTotal(0); setMemoryQuery(''); setMemoryOpen(false);
  }
  async function ensureSession(token) {
    if (session) return session;
    const created = await createRemoteSession(mode, token);
    if (!current(token)) throw cancelError();
    activeId.current = created.id; setSession(created);
    refreshSessions();
    return created;
  }

  async function createSession(nextMode) {
    if (!requireConnection() || lock.current) return;
    epoch.current++;
    const token = begin('session');
    try {
      const data = await createRemoteSession(nextMode, token);
      if (!current(token)) return;
      rememberMode();
      setDraft(nextMode === mode ? draft || lastRequest?.content || '' : '');
      installSession(data, nextMode);
      refreshSessions();
      inputRef.current?.focus();
    } catch (e) { fail(e, token); }
    finally { finish(token); }
  }
  // 写入与召回各持有独立会话；消息、草稿和重试键必须与对应会话一起恢复。
  function rememberMode() {
    modeViews.current[mode] = { session, messages, messagePage, draft, lastRequest, error, memories, memoryPage, memoryTotal, memoryQuery, memoryOpen };
  }
  function changeMode(nextMode) {
    if (lock.current || nextMode === mode) return;
    rememberMode();
    const view = modeViews.current[nextMode];
    memoryVersion.current++;
    activeId.current = view?.session?.id || null;
    scrollKeep.current = null;
    setSession(view?.session || null); setMode(nextMode); setMessages(view?.messages || []);
    setMessagePage(view?.messagePage || 1); setDraft(view?.draft || '');
    setLastRequest(view?.lastRequest || null); setError(view?.error || '');
    setMemories(view?.memories || []); setMemoryPage(view?.memoryPage || 1);
    setMemoryTotal(view?.memoryTotal || 0); setMemoryQuery(view?.memoryQuery || '');
    setMemoryOpen(view?.memoryOpen || false); setMemoriesLoading(false);
  }
  async function send(retry = null) {
    const content = (retry?.content ?? draft).trim();
    if (!content || lock.current || !requireConnection()) return;
    const token = begin('chat');
    try {
      // 与宠物页共用 HTTP 兼容编号；准备失败同样经过 finally 释放操作锁。
      const request = retry || { content, request_id: newRequestId(), pet_name: '记忆助手' };
      setLastRequest(request); setDraft('');
      setMessages(previous => [...previous.filter(message => message.id !== `pending-${request.request_id}`), { id: `pending-${request.request_id}`, role: 'user', content: request.content, created_at: new Date().toISOString(), pending: true }]);
      const target = await ensureSession(token);
      const result = await post(`/sessions/${target.id}/chat`, request, token.controller.signal);
      if (token.controller.signal.aborted) throw cancelError();
      if (!current(token, target.id)) return;
      const ids = new Set([`pending-${request.request_id}`, result.user_message.id, result.assistant_message.id]);
      setMessages(previous => [...previous.filter(message => !ids.has(message.id)), result.user_message, result.assistant_message]);
      setLastRequest(null); refreshSessions(sessionPage);
    } catch (e) { fail(e, token); }
    finally { finish(token); inputRef.current?.focus(); }
  }
  function cancel() { lock.current?.controller.abort(); }
  function replaceCandidate(updated, token, id) {
    if (!current(token, id)) return;
    setMessages(previous => previous.map(message => ({ ...message, candidates: message.candidates?.map(candidate => candidate.id === updated.id ? updated : candidate) })));
  }
  async function candidateMutation(candidate, content, rejected = false) {
    if (!session || lock.current) return false;
    if (!rejected && !content.trim()) { setError('记忆内容不能为空，请补充内容或拒绝这条候选。'); return false; }
    const token = begin('candidate'); const id = session.id; setWritingId(candidate.id);
    try {
      const updated = await patch(`/sessions/${id}/candidates/${candidate.id}`, rejected ? { status: 'rejected' } : { content: content.trim() });
      replaceCandidate(updated, token, id);
      return current(token, id);
    } catch (e) { fail(e, token); return false; }
    finally { finish(token); }
  }
  async function confirm(candidate) {
    if (!session || lock.current) return;
    const token = begin('confirm'); const id = session.id; setWritingId(candidate.id);
    try {
      const updated = await post(`/sessions/${id}/memories/confirm`, { candidate_id: candidate.id }, token.controller.signal);
      if (token.controller.signal.aborted) throw cancelError();
      if (updated.status !== 'confirmed' || !Array.isArray(updated.memory_ids) || !updated.memory_ids.length || updated.memory_ids.some(memoryId => typeof memoryId !== 'string' || !memoryId.trim())) {
        throw new Error('服务尚未返回真实记忆编号，请按原内容重试确认。');
      }
      replaceCandidate(updated, token, id);
      if (current(token, id) && memoryOpen) await loadMemories(id, 1, memoryQuery);
    } catch (e) { fail(e, token); }
    finally { finish(token); }
  }

  async function openSession(item) {
    if (lock.current) return;
    if (item.surface && item.surface !== 'memory') { setError('该会话不属于普通记忆页面。'); return; }
    epoch.current++;
    const token = begin('history');
    try {
      const first = await api(`/sessions/${item.id}/messages?page=1&limit=100`, { signal: token.controller.signal });
      const last = Math.max(1, first.total_pages || 1);
      const page = last > 1 ? await api(`/sessions/${item.id}/messages?page=${last}&limit=100`, { signal: token.controller.signal }) : first;
      if (token.controller.signal.aborted) throw cancelError();
      if (!current(token)) return;
      rememberMode(); setDraft('');
      installSession(item, item.mode);
      setMessages(page.items || []); setMessagePage(last);
    } catch (e) { fail(e, token); }
    finally { finish(token); }
  }
  async function earlier() {
    if (!session || lock.current || messagePage <= 1) return;
    const token = begin('earlier'); const id = session.id;
    try {
      const data = await api(`/sessions/${id}/messages?page=${messagePage - 1}&limit=100`, { signal: token.controller.signal });
      if (!current(token, id)) return;
      const ids = new Set(data.items.map(message => message.id));
      scrollKeep.current = { top: scrollRef.current.scrollTop, height: scrollRef.current.scrollHeight };
      setMessages(previous => [...data.items, ...previous.filter(message => !ids.has(message.id))]);
      setMessagePage(previous => previous - 1);
    } catch (e) { fail(e, token); }
    finally { finish(token); }
  }
  async function loadMemories(id, page = 1, query = '') {
    const version = ++memoryVersion.current; setMemoriesLoading(true);
    try {
      const data = await api(`/sessions/${id}/memories?page=${page}&limit=20&q=${encodeURIComponent(query)}`);
      if (!mounted.current || activeId.current !== id || version !== memoryVersion.current) return;
      setMemories(data.items || []); setMemoryPage(page); setMemoryTotal(data.total || 0);
    } catch (e) {
      if (mounted.current && activeId.current === id && version === memoryVersion.current) setError(e.message);
    } finally {
      if (mounted.current && version === memoryVersion.current) setMemoriesLoading(false);
    }
  }
  async function viewMemories(query = '') {
    if (!requireConnection() || lock.current) return;
    const token = begin('memories');
    try {
      const target = await ensureSession(token);
      if (!current(token, target.id)) return;
      setMemoryOpen(true); setMemoryQuery(query);
      await loadMemories(target.id, 1, query);
    } catch (e) { fail(e, token); }
    finally { finish(token); }
  }
  function memorySearch(page = 1) { if (session) loadMemories(session.id, page, memoryQuery); }
  async function connected() {
    modeViews.current = {}; setDraft(''); scrollKeep.current = null;
    epoch.current++; sessionListVersion.current++; memoryVersion.current++;
    const version = epoch.current;
    lock.current?.controller.abort(); lock.current = null;
    activeId.current = null; setSession(null); setMessages([]); setLastRequest(null); setMessagePage(1); setMemories([]); setMemoryOpen(false); setSessions([]); setMemoryTotal(0); setBusy(false); setError('');
    try {
      const data = await api('/status');
      if (mounted.current && version === epoch.current) setStatus(data);
    }
    catch (e) { if (mounted.current && version === epoch.current) setError(e.message); }
  }

  return {
    status, connectionOpen, setConnectionOpen, connected, mode, changeMode, session, messages, draft, setDraft,
    busy, operation, error, setError, lastRequest, send, cancel, createSession, candidateMutation, confirm, writingId,
    sessions, sessionPage, sessionPages, sessionsLoading, refreshSessions, openSession, earlier, messagePage,
    memoryOpen, setMemoryOpen, memories, memoryPage, memoryTotal, memoryQuery, setMemoryQuery, memoriesLoading, memorySearch, viewMemories,
    scrollRef, inputRef,
  };
}
