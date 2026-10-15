import { API_BASE_URL } from './config.js';

let csrfToken = '';
let sessionVersion = 0;
const invalidationListeners = new Set();

/** 只在内存保存 CSRF；切换会话后拒收上一账号的迟到响应。 */
export function setApiSession(token = '') {
  if (csrfToken !== token) sessionVersion++;
  csrfToken = token;
}
export function invalidateApiSession() {
  csrfToken = '';
  sessionVersion++;
  invalidationListeners.forEach(listener => listener());
}
export function onSessionInvalidated(listener) {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/** Cookie 由浏览器管理，所有业务变更自动附带 CSRF。 */
export async function api(path, options = {}) {
  const version = sessionVersion;
  const authRequest = path.startsWith('/auth/');
  const publicAuth = ['/auth/login', '/auth/register'].includes(path);
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase());
  const response = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(mutation && !publicAuth && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...options.headers },
  });
  let body;
  try { body = await response.json(); }
  catch { body = null; }
  // 即使旧请求返回 401，也不能让新账号退出。
  if (!authRequest && version !== sessionVersion) throw new DOMException('账号已切换，本次请求已取消。', 'AbortError');
  if (response.status === 401 && !authRequest) invalidateApiSession();
  if (!body) throw new Error('服务返回了无法识别的响应，请检查服务地址。');
  if (!response.ok || body.code !== 0) {
    const error = new Error(body.message || '请求失败，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return body.data;
}
export const post = (path, data, signal) => api(path, { method: 'POST', body: JSON.stringify(data), signal });
export const patch = (path, data) => api(path, { method: 'PATCH', body: JSON.stringify(data) });

/** SSE 按 UTF-8 增量解码；只有 done 事件才代表成功，断流可按原编号重试。 */
export async function streamChat(path, data, { signal, voice = false, onEvent = () => {} } = {}) {
  const version = sessionVersion;
  const response = await fetch(`${API_BASE_URL.replace(/\/+$/, '')}${path}`, {
    method: 'POST', credentials: 'include', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Voice-Enabled': String(voice), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    body: JSON.stringify(data),
  });
  const current = () => {
    if (signal?.aborted || version !== sessionVersion) throw new DOMException('本次请求已取消。', 'AbortError');
  };
  current();
  if (response.status === 401) invalidateApiSession();
  if (!response.ok || !response.headers?.get('content-type')?.includes('text/event-stream')) {
    const body = await response.json(); current();
    if (!response.ok || body.code !== 0) throw new Error(body.message || '对话请求失败，请重试。');
    return body.data;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', result;
  try {
    while (true) {
      const { value, done } = await reader.read(); current();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const kind = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!kind || !payload) continue;
        const event = JSON.parse(payload);
        if (kind === 'error') throw new Error(event.message || '对话流中断，请重试。');
        if (kind === 'done') { result = event; break; }
        await onEvent(kind, event); current();
      }
      if (result) return result;
      if (buffer.length > 2 ** 20) throw new Error('对话流数据异常，请重试。');
      if (done) throw new Error('对话流意外中断，请重试这条消息。');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function openAsrSocket() {
  const url = new URL(`${API_BASE_URL.replace(/\/+$/, '')}/speech/asr`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const version = sessionVersion;
  socket.addEventListener('open', () => {
    if (version !== sessionVersion) socket.close();
    else socket.send(JSON.stringify({ csrf_token: csrfToken }));
  });
  return socket;
}
