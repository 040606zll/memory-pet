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
