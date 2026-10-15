vi.mock('../src/config.js', () => ({ API_BASE_URL: '/api' }));
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('@rive-app/webgl2', () => import('./riveMock.js'));
import { App } from '../src/App.jsx';
import { AuthGate, AuthProvider } from '../src/AuthProvider.jsx';

let routes, calls;
const ok = data => ({ ok: true, json: async () => ({ code: 0, message: '成功', data }) });
const configured = { connected: true, memoryos: { configured: true, base_url: 'http://127.0.0.1:8863', user_id: 'owner' }, llm: { configured: true } };
beforeEach(() => {
  calls = []; routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url, options, data: options.body ? JSON.parse(options.body) : null });
    if (routes[url]) return routes[url](options);
    if (url === '/api/status') return ok(configured);
    if (url === '/api/sessions') return ok({ id: 's1', mode: 'training' });
    if (url.includes('/memories?')) return ok({ items: [], total: 0, page: 1 });
    if (url === '/assets/panda-animation.json') return { ok: false };
    return ok({});
  }));
});

it('状态查询失败可关闭提示，系统减少动画设置变化即时生效，空昵称恢复默认值', async () => {
  let change;
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false, addEventListener: (_, callback) => { change = callback; }, removeEventListener: vi.fn() });
  routes['/api/status'] = () => { throw new Error('状态暂不可用'); };
  render(<App />);
  expect(await screen.findByText('状态暂不可用')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭错误提示' }));
  expect(document.querySelector('.error-banner')).toBeNull();
  act(() => change({ matches: true }));
  expect(screen.getByText('安静陪着你')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '训练' }));
  fireEvent.click(screen.getByRole('button', { name: '修改宠物名字' }));
  const name = screen.getByLabelText('宠物名字');
  fireEvent.change(name, { target: { value: '  ' } });
  fireEvent.keyDown(name, { key: 'a' }); expect(screen.getByLabelText('宠物名字')).toBeInTheDocument();
  fireEvent.keyDown(name, { key: 'Enter' });
  expect(screen.getByRole('heading', { name: '教小忆更懂你' })).toBeInTheDocument();
});

it('空消息不提交，未连接空态入口可打开连接说明', async () => {
  routes['/api/status'] = () => ok({ ...configured, connected: false });
  render(<App />); await screen.findByText('尚未连接');
  fireEvent.submit(screen.getByLabelText('训练消息').closest('form'));
  expect(calls.some(call => call.options.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '检查记忆服务，开始聊天' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('记忆服务：等待连接');
});

it('修改和拒绝候选失败时保持候选，显示具体错误并释放操作锁', async () => {
  routes['/api/sessions/s1/chat'] = () => ok({ user_message: { id: 'u', role: 'user', content: '偏好' }, assistant_message: { id: 'a', role: 'assistant', content: '请确认', candidates: [{ id: 'c', content: '原始偏好', status: 'pending' }] } });
  routes['/api/sessions/s1/candidates/c'] = () => { throw new Error('候选服务不可用'); };
  render(<App />); await screen.findByText('记忆已连接');
  const input = screen.getByLabelText('训练消息');
  fireEvent.change(input, { target: { value: '偏好' } }); fireEvent.submit(input.closest('form'));
  await screen.findByText('原始偏好');
  fireEvent.click(screen.getByRole('button', { name: '修改', exact: true }));
  fireEvent.change(screen.getByLabelText('修改记忆内容'), { target: { value: '改后的偏好' } });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(await screen.findByText('候选服务不可用')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }));
  expect(screen.getByText('原始偏好')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '拒绝记忆：原始偏好' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '拒绝记忆：原始偏好' })).toBeEnabled());
  expect(document.querySelector('.error-banner')).toHaveTextContent('候选服务不可用');
  expect(screen.getByText('原始偏好')).toBeInTheDocument();
});

it.each([false, true])('历史加载失败只影响当前请求，关闭后迟到错误被忽略：%s', async stale => {
  let reject;
  routes['/api/sessions?page=1&limit=20'] = () => ok({ items: [{ id: 'failed', mode: 'training', title: '异常历史' }] });
  routes['/api/sessions/failed/messages?page=1&limit=100'] = () => new Promise((_, fail) => { reject = fail; });
  render(<App />); await screen.findByText('记忆已连接');
  fireEvent.click(screen.getByRole('button', { name: '打开菜单' })); fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
  fireEvent.click(await screen.findByRole('button', { name: /异常历史/ }));
  await waitFor(() => expect(reject).toBeDefined());
  if (stale) fireEvent.click(screen.getByRole('button', { name: '关闭历史对话' }));
  await act(async () => reject(new Error('读取会话失败')));
  if (stale) expect(document.querySelector('.error-banner')).toBeNull();
  else expect(document.querySelector('.error-banner')).toHaveTextContent('读取会话失败');
});

it.each(['current-error', 'stale-error', 'stale-success'])('更早消息请求的错误与会话切换隔离：%s', async scenario => {
  let resolve, reject;
  routes['/api/sessions?page=1&limit=20'] = () => ok({ items: [{ id: 'pages', mode: 'training', title: '分页历史' }] });
  routes['/api/sessions/pages/messages?page=1&limit=100'] = () => ok({ items: [], total_pages: 3 });
  routes['/api/sessions/pages/messages?page=3&limit=100'] = () => ok({ items: [{ id: 'a', role: 'assistant', content: '最后一页' }] });
  routes['/api/sessions/pages/messages?page=2&limit=100'] = () => new Promise((done, fail) => { resolve = done; reject = fail; });
  render(<App />); await screen.findByText('记忆已连接');
  fireEvent.click(screen.getByRole('button', { name: '打开菜单' })); fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
  fireEvent.click(await screen.findByRole('button', { name: /分页历史/ }));
  await screen.findAllByText('最后一页');
  fireEvent.click(screen.getByRole('button', { name: '查看更早的消息' }));
  await waitFor(() => expect(resolve).toBeDefined());
  if (scenario !== 'current-error') {
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' })); fireEvent.click(screen.getByRole('button', { name: '开启新对话' }));
  }
  await act(async () => scenario === 'stale-success' ? resolve(ok({ items: [{ id: 'late', role: 'user', content: '迟到的上一页' }] })) : reject(new Error('读取上一页失败')));
  if (scenario === 'current-error') {
    expect(document.querySelector('.error-banner')).toHaveTextContent('读取上一页失败');
    expect(screen.getByRole('button', { name: '查看更早的消息' })).toBeEnabled();
  } else {
    expect(document.querySelector('.error-banner')).toBeNull();
    expect(screen.queryByText('迟到的上一页')).toBeNull();
    expect(screen.getByText('从了解你开始')).toBeInTheDocument();
  }
});

describe('宠物名字与对话同步', () => {
  function reply(petName, index = 1) {
    return ok({ user_message: { id: `name-u${index}`, role: 'user', content: '你的名字叫羊狗' }, assistant_message: { id: `name-a${index}`, role: 'assistant', content: `名字回复${index}`, pet_name: petName, candidates: [{ id: `name-c${index}`, content: '宠物名字是羊狗', status: 'pending' }] } });
  }
  async function sendName(content = '你的名字叫羊狗') {
    const input = screen.getByRole('textbox', { name: '训练消息' });
    fireEvent.change(input, { target: { value: content } }); fireEvent.submit(input.closest('form'));
    await waitFor(() => expect(input).toBeEnabled());
  }
  it('采用后端解析的名字，更新页面和后续请求，但不会自动确认名字记忆', async () => {
    routes['/api/sessions/s1/chat'] = () => reply(' 羊狗 ');
    render(<App />); await screen.findByText('记忆已连接'); await sendName();
    expect(screen.getByRole('heading', { name: '教羊狗更懂你' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '羊狗的房间' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '教羊狗更懂你' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /机器狗羊狗/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '摸摸羊狗' })).toBeInTheDocument();
    expect(localStorage.getItem('memory-pet-name')).toBe('羊狗');
    expect(calls.some(call => call.url.endsWith('/memories/confirm'))).toBe(false);
    let resolveReply;
    routes['/api/sessions/s1/chat'] = () => new Promise(resolve => { resolveReply = resolve; });
    const pending = sendName('你叫什么');
    await waitFor(() => expect(resolveReply).toBeDefined());
    expect(screen.getByText(/羊狗正在想一想/)).toBeInTheDocument();
    expect(calls.filter(call => call.url.endsWith('/chat')).at(-1).data.pet_name).toBe('羊狗');
    await act(async () => resolveReply(reply('羊狗', 2))); await pending;
  });
  it.each([undefined, null, '', '  ', '这是一段超过十二个字符的非法名字', '羊\n狗', 123, { name: '羊狗' }])('忽略无效名字字段 %j，不从自由文本猜名字或重置现有名字', async value => {
    localStorage.setItem('memory-pet-name', '团团');
    routes['/api/sessions/s1/chat'] = () => reply(value);
    render(<App />); await screen.findByText('记忆已连接'); await sendName();
    expect(screen.getByRole('heading', { name: '教团团更懂你' })).toBeInTheDocument();
    expect(localStorage.getItem('memory-pet-name')).toBe('团团');
  });
  it('失败请求不修改宠物名字', async () => {
    localStorage.setItem('memory-pet-name', '团团');
    routes['/api/sessions/s1/chat'] = () => ({ ok: false, json: async () => ({ code: 502, message: '对话暂不可用', data: { assistant_message: { pet_name: '羊狗' } } }) });
    render(<App />); await screen.findByText('记忆已连接'); await sendName();
    expect(screen.getByRole('heading', { name: '教团团更懂你' })).toBeInTheDocument();
    expect(localStorage.getItem('memory-pet-name')).toBe('团团');
  });
  it('等待回复时手动修改的名字不被迟到回复覆盖，后续请求采用手动新名', async () => {
    let resolveReply;
    routes['/api/sessions/s1/chat'] = () => new Promise(resolve => { resolveReply = resolve; });
    render(<App />); await screen.findByText('记忆已连接');
    const pending = sendName(); await waitFor(() => expect(resolveReply).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '修改宠物名字' }));
    const input = screen.getByRole('textbox', { name: '宠物名字' });
    fireEvent.change(input, { target: { value: '团团' } }); fireEvent.blur(input);
    await act(async () => resolveReply(reply('羊狗'))); await pending;
    expect(screen.getByRole('heading', { name: '教团团更懂你' })).toBeInTheDocument();
    expect(localStorage.getItem('memory-pet-name')).toBe('团团');
    routes['/api/sessions/s1/chat'] = () => reply(undefined, 2); await sendName('你好');
    expect(calls.filter(call => call.url.endsWith('/chat')).at(-1).data.pet_name).toBe('团团');
  });
  it('恢复历史会话不让旧名字覆盖账号当前缓存', async () => {
    localStorage.setItem('memory-pet-name', '团团');
    routes['/api/sessions?page=1&limit=20'] = () => ok({ items: [{ id: 'old-name', mode: 'training', title: '旧名字会话' }] });
    routes['/api/sessions/old-name/messages?page=1&limit=100'] = () => ok({ items: [{ id: 'old-name-a', role: 'assistant', content: '以前的名字', pet_name: '小忆' }] });
    render(<App />); await screen.findByText('记忆已连接');
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' })); fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(await screen.findByRole('button', { name: /旧名字会话/ }));
    await screen.findAllByText('以前的名字');
    expect(screen.getByRole('heading', { name: '教团团更懂你' })).toBeInTheDocument();
    expect(localStorage.getItem('memory-pet-name')).toBe('团团');
  });
  it('登录账号分别保存宠物名字，旧全局名字不会分配给任意账号', async () => {
    localStorage.setItem('memory-pet-name', '旧账号昵称');
    let accountId = 'alice';
    routes['/api/auth/me'] = () => ok({ user: { id: accountId, username: accountId }, csrf_token: `csrf-${accountId}` });
    routes['/api/sessions/s1/chat'] = () => reply('羊狗');
    render(<AuthProvider><AuthGate><App /></AuthGate></AuthProvider>);
    await screen.findByText('记忆已连接');
    expect(screen.getByRole('heading', { name: '教小忆更懂你' })).toBeInTheDocument();
    await sendName(); expect(localStorage.getItem('memory-pet-name:alice')).toBe('羊狗');
    accountId = 'bob'; act(() => window.dispatchEvent(new Event('focus')));
    await screen.findByText('账号：bob');
    expect(screen.getByRole('heading', { name: '教小忆更懂你' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '修改宠物名字' }));
    fireEvent.change(screen.getByRole('textbox', { name: '宠物名字' }), { target: { value: '团团' } });
    fireEvent.blur(screen.getByRole('textbox', { name: '宠物名字' }));
    expect(localStorage.getItem('memory-pet-name:bob')).toBe('团团');
    accountId = 'alice'; act(() => window.dispatchEvent(new Event('focus')));
    await screen.findByText('账号：alice');
    expect(screen.getByRole('heading', { name: '教羊狗更懂你' })).toBeInTheDocument();
    expect(screen.getByText('你好，我是羊狗。')).toBeInTheDocument();
    expect(localStorage.getItem('memory-pet-name')).toBe('旧账号昵称');
  });
});

describe('真实对话与记忆确认界面', () => {
  it('编号准备失败时恢复发送按钮、保留草稿并且不调用会话或聊天接口', async () => {
    vi.stubGlobal('crypto', {});
    try {
      render(<App />); await screen.findByText('记忆已连接');
      const input = screen.getByRole('textbox', { name: '训练消息' });
      fireEvent.change(input, { target: { value: '尚未提交的内容' } });
      fireEvent.submit(input.closest('form'));
      await screen.findByText('浏览器不支持生成消息编号，请更换浏览器后重试。');
      expect(input).toBeEnabled(); expect(input).toHaveValue('尚未提交的内容');
      expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
      expect(calls.filter(call => call.url === '/api/sessions' || call.url.endsWith('/chat'))).toHaveLength(0);
      fireEvent.click(screen.getByRole('tab', { name: '正式对话' }));
      expect(screen.getByRole('textbox', { name: '对话消息' })).toBeEnabled();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['训练', '正式对话'])('HTTP 环境缺少 randomUUID 时%s仍提交聊天接口并结束等待', async mode => {
    const crypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      routes['/api/sessions/s1/chat'] = () => ok({ user_message: { id: 'http-user', role: 'user', content: '你的名字叫羊狗' }, assistant_message: { id: 'http-reply', role: 'assistant', content: 'HTTP 兼容回复', candidates: [], memories: [] } });
      render(<App />); await screen.findByText('记忆已连接');
      if (mode === '正式对话') fireEvent.click(screen.getByRole('tab', { name: mode }));
      const input = screen.getByRole('textbox', { name: mode === '训练' ? '训练消息' : '对话消息' });
      fireEvent.change(input, { target: { value: '你的名字叫羊狗' } });
      fireEvent.submit(input.closest('form'));
      await waitFor(() => expect(calls.filter(call => call.url.endsWith('/chat'))).toHaveLength(1));
      expect(calls.find(call => call.url.endsWith('/chat')).data.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      await screen.findAllByText('HTTP 兼容回复');
      await waitFor(() => expect(input).toBeEnabled());
      expect(screen.queryByRole('button', { name: '取消本次对话' })).not.toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });
  it('真实首页空态，未伪造长期记忆或已经训练的状态', async () => {
    render(<App />);
    expect(screen.getByText('从了解你开始')).toBeInTheDocument();
    expect(screen.queryByText('喜欢听雨声')).not.toBeInTheDocument();
    expect(screen.getByText('Lv.1')).toBeInTheDocument();
    await screen.findByText('记忆已连接');
  });
  it('Enter发送、禁重复发，完成回复显示候选；修改、拒绝与确认使用真实API', async () => {
    const user = userEvent.setup();
    let replyResolve;
    routes['/api/sessions/s1/chat'] = () => new Promise(resolve => { replyResolve = resolve; });
    render(<App />); await screen.findByText('记忆已连接');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '请记住我喜欢雨声{enter}');
    await waitFor(() => expect(replyResolve).toBeDefined());
    expect(screen.getByRole('textbox', { name: '训练消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消本次对话' })).toBeInTheDocument();
    fireEvent.submit(screen.getByRole('textbox', { name: '训练消息' }).closest('form'));
    expect(calls.filter(c => c.url.endsWith('/chat'))).toHaveLength(1);
    replyResolve(ok({ user_message: { id: 'u1', role: 'user', content: '请记住我喜欢雨声' }, assistant_message: { id: 'a1', role: 'assistant', content: '确认后我会记住。', actions: [{ name: 'nod', trigger: 'emotion' }], candidates: [{ id: 'c1', content: '喜欢雨声', status: 'pending' }, { id: 'c2', content: '喜欢自然', status: 'pending' }] } }));
    await screen.findByText('待确认的记忆');
    routes['/api/sessions/s1/candidates/c1'] = options => ok({ id: 'c1', content: JSON.parse(options.body).content, status: 'pending' });
    await user.click(screen.getByRole('button', { name: '修改', exact: true }));
    const edits = screen.getAllByRole('textbox', { name: '修改记忆内容' });
    await user.clear(edits[0]);
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText('记忆内容不能为空，请补充内容或拒绝这条记忆。');
    await user.type(edits[0], '喜欢下雨的声音');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText('喜欢下雨的声音');
    routes['/api/sessions/s1/candidates/c2'] = () => ok({ id: 'c2', content: '喜欢自然', status: 'rejected' });
    await user.click(screen.getByRole('button', { name: '拒绝记忆：喜欢自然' }));
    await waitFor(() => expect(screen.queryByText('喜欢自然')).not.toBeInTheDocument());
    routes['/api/sessions/s1/memories/confirm'] = () => ok({ id: 'c1', content: '喜欢下雨的声音', status: 'confirmed', memory_ids: ['m1'] });
    routes['/api/sessions/s1/memories?page=1&limit=20&q='] = () => ok({ items: [{ id: 'm1', content: '喜欢下雨的声音' }], total: 1 });
    await user.click(screen.getByRole('button', { name: '确认记住' }));
    await screen.findByText('已学会 1 条偏好');
    expect(calls.find(c => c.url.endsWith('/memories/confirm')).data).toEqual({ candidate_id: 'c1' });
  });
  it('失败重试沿用request_id，Shift+Enter换行且不会发送', async () => {
    const user = userEvent.setup();
    routes['/api/sessions/s1/chat'] = () => ({ ok: false, json: async () => ({ code: 502, message: '记忆服务暂不可用。' }) });
    render(<App />); await screen.findByText('记忆已连接');
    const input = screen.getByRole('textbox', { name: '训练消息' });
    await user.type(input, '第一行'); await user.keyboard('{Shift>}{Enter}{/Shift}'); await user.type(input, '第二行');
    expect(input.value).toBe('第一行\n第二行'); expect(calls.filter(c => c.url.endsWith('/chat'))).toHaveLength(0);
    await user.keyboard('{Enter}'); await screen.findByText('记忆服务暂不可用。');
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(calls.filter(c => c.url.endsWith('/chat'))).toHaveLength(2));
    const requests = calls.filter(c => c.url.endsWith('/chat')); expect(requests[0].data.request_id).toBe(requests[1].data.request_id);
  });
  it('取消中断网络请求，保留原消息供幂等重试', async () => {
    const user = userEvent.setup();
    routes['/api/sessions/s1/chat'] = options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError'))));
    render(<App />); await screen.findByText('记忆已连接');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '等待{enter}');
    await waitFor(() => expect(calls.some(c => c.url.endsWith('/chat'))).toBe(true));
    await user.click(screen.getByRole('button', { name: '取消本次对话' }));
    await screen.findByText('本次对话已取消。你可以重试这条消息。');
    expect(calls.find(c => c.url.endsWith('/chat')).options.signal.aborted).toBe(true);
  });
  it('未连接时仅显示服务状态，重试不提交任何凭据', async () => {
    const user = userEvent.setup(); routes['/api/status'] = () => ok({ ...configured, connected: false });
    routes['/api/connection'] = () => ok({ connected: true });
    render(<App />); await screen.findByText('尚未连接');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '你好{enter}');
    await screen.findByRole('dialog');
    const keys = document.querySelectorAll('input[type=password]'); expect(keys).toHaveLength(0);
    expect(screen.queryByLabelText('模型名称')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API 地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('用户 ID')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试连接', exact: true }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/connection')).toBe(true));
    expect(calls.find(c => c.url === '/api/connection').data).toEqual({});
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret');
  });
  it('正式对话使用独立会话，隐藏记忆标签且不自动确认', async () => {
    const user = userEvent.setup();
    routes['/api/sessions'] = options => ok({ id: 'chat-only', mode: JSON.parse(options.body).mode });
    routes['/api/sessions/chat-only/chat'] = () => ok({ user_message: { id: 'u1', role: 'user', content: '你好' }, assistant_message: { id: 'a1', role: 'assistant', content: '你好呀', memories: [{ id: 'm1', content: '喜欢雨声', source: 'memoryos' }] } });
    render(<App />); await screen.findByText('记忆已连接');
    await user.click(screen.getByRole('tab', { name: '正式对话' }));
    await user.type(screen.getByRole('textbox', { name: '对话消息' }), '你好{enter}'); await screen.findAllByText('你好呀');
    expect(screen.queryByText('用到记忆：喜欢雨声')).not.toBeInTheDocument();
    expect(calls.find(c => c.url === '/api/sessions').data.mode).toBe('chat');
    expect(calls.filter(c => c.url.endsWith('/memories/confirm'))).toHaveLength(0);
  });
});

describe('补充交互与异常边界', () => {
  it('原型预览明确区分，模式可切换且不会写记忆，退出恢复真实空态', async () => {
    const user = userEvent.setup(); render(<App />); await screen.findByText('记忆已连接');
    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    await user.click(screen.getByRole('button', { name: '查看原型预览' }));
    expect(screen.getByText('原型预览')).toBeInTheDocument();
    expect(screen.getByText('待确认的记忆')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认记住' }));
    await screen.findByText('预览中的记忆不能写入服务。');
    expect(calls.filter(c => c.url.endsWith('/memories/confirm'))).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }));
    await user.click(screen.getByRole('button', { name: '修改', exact: true }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText('预览中的记忆不能写入服务。');
    await user.click(screen.getByRole('tab', { name: '正式对话' }));
    expect(screen.queryByText('小忆记得')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '对话消息' }), '你好{enter}');
    await screen.findByText('当前是静态原型预览，请退出预览并连接服务后开始对话。');
    await user.click(screen.getByRole('button', { name: '退出原型预览' }));
    expect(screen.getByText('今天想和我聊什么？')).toBeInTheDocument();
  });
  it('历史会话重载真实消息，宠物页移除长期记忆弹窗和列表', async () => {
    const user = userEvent.setup();
    routes['/api/sessions?page=1&limit=20'] = () => ok({ items: [{ id: 'old', mode: 'chat', title: '昨天的小事', created_at: '2026-10-13T12:00:00' }] });
    routes['/api/sessions/old/messages?page=1&limit=100'] = () => ok({ items: [{ id: 'old-a', role: 'assistant', content: '昨天聊过散步。', memories: [] }] });
    routes['/api/sessions/old/memories?page=1&limit=20&q='] = () => ok({ items: [{ id: 'm1', content: '喜欢散步' }], total: 25 });
    routes['/api/sessions/old/memories?page=2&limit=20&q='] = () => ok({ items: [{ id: 'm25', content: '喜欢公园' }], total: 25 });
    routes['/api/sessions/old/memories?page=1&limit=20&q=%E5%85%AC%E5%9B%AD'] = () => ok({ items: [{ id: 'm25', content: '喜欢公园' }], total: 1 });
    render(<App />); await screen.findByText('记忆已连接');
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '历史对话' }));
    await user.click(await screen.findByRole('button', { name: /昨天的小事/ }));
    await screen.findAllByText('昨天聊过散步。');
    expect(screen.queryByText('小忆记得')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '搜索长期记忆' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '开启新对话' }));
    expect(screen.getByText('今天想和我聊什么？')).toBeInTheDocument();
    expect(screen.queryByText('喜欢公园')).not.toBeInTheDocument();
  });
  it('改名只存宠物昵称；暂停与恢复不会伪造对话', async () => {
    const user = userEvent.setup(); render(<App />); await screen.findByText('记忆已连接');
    await user.click(screen.getByRole('button', { name: '修改宠物名字' }));
    const input = screen.getByRole('textbox', { name: '宠物名字' }); await user.clear(input); await user.type(input, '团团{enter}');
    expect(localStorage.getItem('memory-pet-name')).toBe('团团');
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '暂停宠物动作' }));
    expect(screen.getByText('安静陪着你')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '继续陪伴' }));
    expect(screen.queryByText('安静陪着你')).not.toBeInTheDocument();
  });
  it('训练和正式对话提供语音入口，未经点击不启动录音', async () => {
    const user = userEvent.setup();
    const recognition = vi.fn();
    const getUserMedia = vi.fn();
    vi.stubGlobal('SpeechRecognition', recognition);
    vi.stubGlobal('webkitSpeechRecognition', recognition);
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
    try {
      render(<App />); await screen.findByText('记忆已连接');
      for (const mode of ['训练消息', '对话消息']) {
        if (mode === '对话消息') await user.click(screen.getByRole('tab', { name: /正式对话/ }));
        expect(screen.getByRole('button', { name: '开始语音输入' })).toBeInTheDocument();
        const input = screen.getByRole('textbox', { name: mode });
        expect(input.closest('form').querySelectorAll('button')).toHaveLength(2);
        await user.type(input, '文字输入');
        expect(input).toHaveValue('文字输入');
        expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
        await user.clear(input);
      }
      expect(recognition).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('语音朗读默认开启，可切换为文字且不调用浏览器朗读', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('speechSynthesis', { speak: vi.fn(), cancel: vi.fn() });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(content) { this.text = content; } });
    routes['/api/sessions/s1/chat'] = () => ok({ user_message: { id: 'v-u', role: 'user', content: '文字输入' }, assistant_message: { id: 'v-a', role: 'assistant', content: '收到文字消息' } });
    try {
      render(<App />); await screen.findByText('记忆已连接');
      await user.type(screen.getByRole('textbox', { name: '训练消息' }), '文字输入');
      await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '关闭语音朗读' }));
      await user.click(screen.getByRole('button', { name: '发送消息' })); await screen.findAllByText('收到文字消息');
      expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
      expect(calls.find(call => call.url.endsWith('/chat')).options.headers['X-Voice-Enabled']).toBe('false');
    } finally { vi.unstubAllGlobals(); }
  });
  it('连接验证失败保留状态弹窗，不宣称已连接；可关闭', async () => {
    const user = userEvent.setup(); routes['/api/status'] = () => ok({ ...configured, connected: false });
    routes['/api/connection'] = () => ({ ok: false, json: async () => ({ code: 502, message: '大模型验证失败。' }) });
    render(<App />); await screen.findByText('尚未连接');
    await user.click(screen.getByRole('button', { name: '记忆服务', exact: true }));
    expect(document.querySelectorAll('input[type=password]')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '重试连接', exact: true }));
    await screen.findByText('大模型验证失败。'); expect(screen.getByText('尚未连接')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭', exact: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('候选确认失败仍可编辑和重试，切换模式不修改原会话', async () => {
    const user = userEvent.setup();
    routes['/api/sessions/s1/chat'] = () => ok({ user_message: { id: 'f-u', role: 'user', content: '雨声' }, assistant_message: { id: 'f-a', role: 'assistant', content: '待确认', candidates: [{ id: 'f-c', content: '喜欢雨声', status: 'pending' }] } });
    routes['/api/sessions/s1/memories/confirm'] = () => ({ ok: false, json: async () => ({ code: 502, message: '记忆仍在处理中。' }) });
    render(<App />); await screen.findByText('记忆已连接');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '雨声{enter}'); await screen.findByText('待确认的记忆');
    await user.click(screen.getByRole('button', { name: '确认记住' })); await screen.findByText('记忆仍在处理中。');
    expect(screen.getByText('待确认的记忆')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '修改', exact: true })); await user.click(screen.getByRole('button', { name: '取消', exact: true }));
    await user.click(screen.getByRole('tab', { name: '正式对话' }));
    expect(screen.queryByText('待确认的记忆')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '训练' }));
    expect(screen.getByText('待确认的记忆')).toBeInTheDocument();
    expect(calls.some(c => c.url === '/api/sessions/s1')).toBe(false);
  });
});

describe('历史分页与跨会话隔离', () => {
  it('超过100条时先打开最后一页，加载上一页按时间合并且不重复', async () => {
    const user = userEvent.setup();
    routes['/api/sessions?page=1&limit=20'] = () => ok({ items: [{ id: 'long', mode: 'chat', title: '很长的对话', created_at: '2026-10-13T12:00:00' }] });
    routes['/api/sessions/long/messages?page=1&limit=100'] = () => ok({ items: [{ id: 'early', role: 'user', content: '最早的内容' }], total: 201, total_pages: 3 });
    routes['/api/sessions/long/messages?page=3&limit=100'] = () => ok({ items: [{ id: 'latest', role: 'assistant', content: '最新的回答' }], total: 201, total_pages: 3 });
    routes['/api/sessions/long/messages?page=2&limit=100'] = () => ok({ items: [{ id: 'middle', role: 'user', content: '中间的内容' }, { id: 'overlap', role: 'assistant', content: '前一页的回答' }, { id: 'latest', role: 'assistant', content: '最新的回答' }], total: 201, total_pages: 3 });
    render(<App />); await screen.findByText('记忆已连接');
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '历史对话' }));
    await user.click(await screen.findByRole('button', { name: /很长的对话/ }));
    await screen.findAllByText('最新的回答');
    expect(screen.queryByText('最早的内容')).not.toBeInTheDocument();
    expect(calls.some(c => c.url.includes('messages?page=3'))).toBe(true);
    await user.click(screen.getByRole('button', { name: '查看更早的消息' })); await screen.findByText('中间的内容');
    const bubbles = [...document.querySelectorAll('.message-bubble')].map(e => e.textContent);
    expect(bubbles).toEqual(['中间的内容', '前一页的回答', '最新的回答']);
    await user.click(screen.getByRole('button', { name: '查看更早的消息' })); await screen.findByText('最早的内容');
    expect(screen.queryByRole('button', { name: '查看更早的消息' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.message-bubble')).toHaveLength(4);
  });
  it('关闭旧会话加载并开启新会话后，迟到的结果不能覆盖新页面', async () => {
    const user = userEvent.setup(); let resolveOld;
    routes['/api/sessions?page=1&limit=20'] = () => ok({ items: [{ id: 'slow', mode: 'chat', title: '慢请求', created_at: '2026-10-13T12:00:00' }] });
    routes['/api/sessions/slow/messages?page=1&limit=100'] = () => new Promise(resolve => { resolveOld = resolve; });
    render(<App />); await screen.findByText('记忆已连接');
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '历史对话' }));
    await user.click(await screen.findByRole('button', { name: /慢请求/ })); await waitFor(() => expect(resolveOld).toBeDefined());
    await user.click(screen.getByRole('button', { name: '关闭历史对话' }));
    await user.click(screen.getByRole('button', { name: '打开菜单' })); await user.click(screen.getByRole('button', { name: '开启新对话' }));
    await act(async () => resolveOld(ok({ items: [{ id: 'old', role: 'assistant', content: '迟到的旧用户内容' }], total_pages: 1 })));
    await waitFor(() => expect(screen.getByText('从了解你开始')).toBeInTheDocument());
    expect(screen.queryByText('迟到的旧用户内容')).not.toBeInTheDocument();
  });
  it('候选确认进行中禁切历史，完成的结果只回写当前会话', async () => {
    const user = userEvent.setup(); let resolveConfirm;
    routes['/api/sessions/s1/chat'] = () => ok({ user_message: { id: 'i-u', role: 'user', content: '喜欢竹子' }, assistant_message: { id: 'i-a', role: 'assistant', content: '来确认这条', candidates: [{ id: 'i-c', content: '喜欢竹子', status: 'pending' }] } });
    routes['/api/sessions/s1/memories/confirm'] = () => new Promise(resolve => { resolveConfirm = resolve; });
    render(<App />); await screen.findByText('记忆已连接');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '喜欢竹子{enter}'); await screen.findByText('待确认的记忆');
    await user.click(screen.getByRole('button', { name: '确认记住' })); await waitFor(() => expect(resolveConfirm).toBeDefined());
    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(screen.getByRole('button', { name: '历史对话' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '开启新对话' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '历史对话' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    resolveConfirm(ok({ id: 'i-c', content: '喜欢竹子', status: 'confirmed' }));
    await waitFor(() => expect(screen.queryByText('待确认的记忆')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '历史对话' })).toBeEnabled();
  });
});


describe('训练与正式对话消息隔离', () => {
  it('切换隐藏另一模式的消息与候选，使用不同会话，返回恢复原记录和草稿', async () => {
    const user = userEvent.setup();
    let sessionCount = 0;
    routes['/api/sessions'] = options => ok({ id: `isolated-${++sessionCount}`, mode: JSON.parse(options.body).mode });
    routes['/api/sessions/isolated-1/chat'] = () => ok({ user_message: { id: 'train-u', role: 'user', content: '训练专属消息' }, assistant_message: { id: 'train-a', role: 'assistant', content: '训练专属回复', candidates: [{ id: 'train-c', content: '训练专属候选', status: 'pending' }] } });
    routes['/api/sessions/isolated-2/chat'] = () => ok({ user_message: { id: 'chat-u', role: 'user', content: '正式专属消息' }, assistant_message: { id: 'chat-a', role: 'assistant', content: '正式专属回复', memories: [{ id: 'm1', content: '已确认偏好', source: 'memoryos' }] } });
    render(<App />); await screen.findByText('记忆已连接');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '训练专属消息{enter}');
    await screen.findByText('训练专属候选');
    await user.type(screen.getByRole('textbox', { name: '训练消息' }), '训练草稿');
    await user.click(screen.getByRole('tab', { name: '正式对话' }));
    expect(screen.queryByText('训练专属消息')).not.toBeInTheDocument();
    expect(screen.queryByText('训练专属回复')).not.toBeInTheDocument();
    expect(screen.queryByText('训练专属候选')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '对话消息' })).toHaveValue('');
    await user.type(screen.getByRole('textbox', { name: '对话消息' }), '正式专属消息{enter}');
    await screen.findAllByText('正式专属回复');
    expect(screen.queryByText('用到记忆：已确认偏好')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '对话消息' }), '正式草稿');
    await user.click(screen.getByRole('tab', { name: '训练' }));
    expect(screen.getByText('训练专属消息')).toBeInTheDocument();
    expect(screen.getByText('训练专属候选')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '训练消息' })).toHaveValue('训练草稿');
    expect(screen.queryByText('正式专属消息')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '正式对话' }));
    expect(screen.getByRole('textbox', { name: '对话消息' })).toHaveValue('正式草稿');
    expect(screen.getByText('正式专属消息')).toBeInTheDocument();
    expect(calls.filter(c => c.url === '/api/sessions').map(c => c.data.mode)).toEqual(['training', 'chat']);
    expect(calls.some(c => c.options.method === 'PATCH' && /^\/api\/sessions\/[^/]+$/.test(c.url))).toBe(false);
  });
});
