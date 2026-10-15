vi.mock('../src/config.js', () => ({ API_BASE_URL: '/api' }));
import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthGate, AuthProvider, AccountControls } from '../src/AuthProvider.jsx';
import { api, onSessionInvalidated, post, setApiSession } from '../src/api.js';

const ok = data => ({ ok: true, status: 200, json: async () => ({ code: 0, data }) });
const denied = (message = '请先登录。') => ({ ok: false, status: 401, json: async () => ({ code: 401, message }) });
const account = (id = 'alice') => ({ user: { id, username: id }, csrf_token: `csrf-${id}` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let routes, requests;
beforeEach(() => {
  setApiSession(); routes = {}; requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    requests.push({ url, options });
    return routes[url] ? routes[url](options) : denied();
  }));
});
afterEach(() => { setApiSession(); vi.unstubAllGlobals(); });
function Business() {
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState('');
  useEffect(() => { api('/status').then(data => setReply(data.message)).catch(() => {}); }, []);
  return <><AccountControls /><input aria-label="业务草稿" value={draft} onChange={e => setDraft(e.target.value)} /><div>{reply}</div><button onClick={() => api('/sessions').catch(() => {})}>请求业务</button></>;
}
function setup() { return render(<AuthProvider><AuthGate><Business /></AuthGate></AuthProvider>); }
async function login(register = false) {
  await screen.findByRole('heading', { name: '欢迎回来' });
  if (register) fireEvent.click(screen.getByRole('button', { name: '创建账号' }));
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: register ? '注册并登录' : '登录', exact: true }));
}
it('未登录只挂载登录页，注册后创建账号视图，所有业务变更携带 Cookie 和 CSRF', async () => {
  routes['/api/auth/register'] = () => ok(account());
  routes['/api/status'] = () => ok({ message: '独立记忆空间' });
  routes['/api/connection'] = () => ok({});
  setup(); await screen.findByRole('heading', { name: '欢迎回来' });
  expect(requests.map(item => item.url)).toEqual(['/api/auth/me']);
  expect(screen.queryByLabelText('业务草稿')).not.toBeInTheDocument();
  await login(true); await screen.findByText('账号：alice');
  await post('/connection', {});
  const registration = requests.find(item => item.url.endsWith('/register'));
  expect(JSON.parse(registration.options.body)).toEqual({ username: 'alice', password: 'password123' });
  expect(registration.options.headers).not.toHaveProperty('X-CSRF-Token');
  expect(requests.find(item => item.url.endsWith('/connection')).options).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': 'csrf-alice' } });
  expect(JSON.stringify({ ...localStorage })).not.toMatch(/password123|csrf-alice/);
});
it('登录错误保留表单和中文错误，业务 401 卸载账号草稿，重新登录为空白', async () => {
  routes['/api/auth/login'] = () => denied('用户名或密码错误。');
  routes['/api/status'] = () => ok({});
  setup(); await login();
  await screen.findByText('用户名或密码错误。');
  expect(screen.getByLabelText('用户名')).toHaveValue('alice');
  routes['/api/auth/login'] = () => ok(account());
  fireEvent.click(screen.getByRole('button', { name: '登录', exact: true }));
  fireEvent.change(await screen.findByLabelText('业务草稿'), { target: { value: '上一账号草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '请求业务' }));
  await screen.findByRole('heading', { name: '欢迎回来' });
  expect(screen.queryByDisplayValue('上一账号草稿')).not.toBeInTheDocument();
  await login(); expect(await screen.findByLabelText('业务草稿')).toHaveValue('');
});
it('退出只在服务端成功后清空状态，跨标签变更和聚焦会重新校验账号并卸载旧数据', async () => {
  routes['/api/auth/me'] = () => ok(account()); routes['/api/status'] = () => ok({});
  routes['/api/auth/logout'] = () => ok(null);
  setup(); fireEvent.change(await screen.findByLabelText('业务草稿'), { target: { value: '私密草稿' } });
  routes['/api/auth/me'] = () => ok(account('bob'));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'memory-pet-session-change', newValue: 'changed' })));
  await screen.findByText('账号：bob'); expect(screen.getByLabelText('业务草稿')).toHaveValue('');
  routes['/api/auth/me'] = () => denied();
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByRole('heading', { name: '欢迎回来' });
  routes['/api/auth/login'] = () => ok(account()); await login(); await screen.findByText('账号：alice');
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  await screen.findByRole('heading', { name: '欢迎回来' });
  expect(requests.find(item => item.url.endsWith('/logout')).options.headers['X-CSRF-Token']).toBe('csrf-alice');
});
it('旧业务 401 和旧成功响应均不能覆盖新账号或清除新 CSRF；登录失败不会触发业务失效', async () => {
  const first = deferred(), second = deferred();
  setApiSession('old'); routes['/api/old-401'] = () => first.promise; routes['/api/old-data'] = () => second.promise;
  const old401 = api('/old-401').catch(error => error); const oldData = api('/old-data').catch(error => error);
  const listener = vi.fn(); const unsubscribe = onSessionInvalidated(listener);
  setApiSession('new'); first.resolve(denied()); second.resolve(ok({ content: '旧账号信息' }));
  expect((await old401).name).toBe('AbortError'); expect((await oldData).name).toBe('AbortError');
  await expect(post('/auth/login', {})).rejects.toThrow('请先登录');
  expect(listener).not.toHaveBeenCalled(); unsubscribe();
  routes['/api/new'] = () => ok({}); await post('/new', {});
  expect(requests.at(-1).options.headers['X-CSRF-Token']).toBe('new');
});
it('延迟登录响应在重新校验后不能恢复旧账号', async () => {
  const pending = deferred(); routes['/api/auth/login'] = () => pending.promise;
  routes['/api/status'] = () => ok({}); setup(); await login();
  routes['/api/auth/me'] = () => ok(account('bob'));
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByText('账号：bob');
  await act(async () => pending.resolve(ok(account('alice'))));
  expect(screen.queryByText('账号：alice')).not.toBeInTheDocument();
});

it('同一账号聚焦校验期间隐藏旧界面，校验成功后保留尚未发送的草稿', async () => {
  routes['/api/auth/me'] = () => ok(account()); routes['/api/status'] = () => ok({});
  setup(); fireEvent.change(await screen.findByLabelText('业务草稿'), { target: { value: '尚未发送' } });
  const pending = deferred(); routes['/api/auth/me'] = () => pending.promise;
  act(() => window.dispatchEvent(new Event('focus')));
  expect(screen.getByRole('status')).toHaveTextContent('正在验证登录状态');
  expect(screen.getByLabelText('业务草稿')).not.toBeVisible();
  await act(async () => pending.resolve(ok(account())));
  expect(screen.getByLabelText('业务草稿')).toBeVisible();
  expect(screen.getByLabelText('业务草稿')).toHaveValue('尚未发送');
});

it('状态服务故障提供重新检查入口；服务恢复后进入账号页面', async () => {
  routes['/api/auth/me'] = () => ({ ok: false, status: 503, json: async () => ({ code: 503, message: '服务暂不可用。' }) });
  setup(); expect(await screen.findByRole('alert')).toHaveTextContent('服务暂不可用');
  routes['/api/auth/me'] = () => ok(account()); routes['/api/status'] = () => ok({});
  fireEvent.click(screen.getByRole('button', { name: '重新检查登录状态' }));
  await screen.findByText('账号：alice');
});
it('退出网络失败保留登录并提示错误，已过期会话退出则清空业务状态', async () => {
  routes['/api/auth/me'] = () => ok(account()); routes['/api/status'] = () => ok({});
  routes['/api/auth/logout'] = () => { throw new Error('服务暂不可用。'); };
  setup(); await screen.findByText('账号：alice');
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('服务暂不可用');
  expect(screen.getByText('账号：alice')).toBeVisible();
  routes['/api/auth/logout'] = () => denied();
  fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
  await screen.findByRole('heading', { name: '欢迎回来' });
});
it('多次校验采用最新结果，旧账号查询的迟到成功不能覆盖新账号', async () => {
  const old = deferred(); routes['/api/auth/me'] = () => old.promise;
  setup(); expect(screen.getByRole('status')).toBeVisible();
  routes['/api/auth/me'] = () => ok(account('bob')); routes['/api/status'] = () => ok({});
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'changed' })));
  expect(requests).toHaveLength(1);
  act(() => window.dispatchEvent(new Event('focus')));
  await screen.findByText('账号：bob');
  await act(async () => old.resolve(ok(account('alice'))));
  expect(screen.queryByText('账号：alice')).not.toBeInTheDocument();
});
