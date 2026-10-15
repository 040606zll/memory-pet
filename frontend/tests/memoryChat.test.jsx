vi.mock('../src/config.js', () => ({ API_BASE_URL: '/api' }));
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MemoryChat from '../src/MemoryChat.jsx';
import { MemoryEvidence, memoryTime } from '../src/MemoryChatParts.jsx';

const item = (id, content, role = 'assistant', extra = {}) => ({ id, content, role, created_at: '2026-10-14T10:00:00Z', ...extra });
const candidate = (id = 'candidate-1', content = '用户喜欢先给结论') => ({ id, content, status: 'pending', memory_ids: [] });
let routes, calls, connected, sessionCount, reply;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (data, ok = true, message = '成功') => ({ ok, json: async () => ({ code: ok ? 0 : 500, message, data }) });
function route(method, path, handler) { routes.set(`${method} ${path}`, handler); }
function bodies(path) { return calls.filter(call => call.path === path).map(call => call.body); }
beforeEach(() => {
  routes = new Map(); calls = []; connected = true; sessionCount = 0;
  reply = { user_message: item('user-1', '我的偏好', 'user'), assistant_message: item('assistant-1', '已整理为待确认候选。', 'assistant', { candidates: [candidate()] }) };
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const path = url.replace('/api', ''); const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body, signal: options.signal });
    const handler = routes.get(`${method} ${path}`);
    if (handler) return handler({ body, signal: options.signal });
    if (path === '/status') return response({ connected, memoryos: { user_id: 'user-test', configured: true }, llm: { configured: true } });
    if (method === 'GET' && path.startsWith('/sessions?')) return response({ items: [], page: 1, total: 0, total_pages: 1 });
    if (path === '/sessions' && method === 'POST') return response({ id: `session-${++sessionCount}`, surface: 'memory', created_at: '2026-10-14', ...body });
    if (path.endsWith('/chat')) return response(reply);
    if (method === 'PATCH' && path.includes('/candidates/')) return response({ ...candidate(path.split('/').at(-1)), ...body });
    if (path.endsWith('/memories/confirm')) return response({ ...candidate(body.candidate_id), status: 'confirmed', memory_ids: ['memory-real-1'] });
    if (method === 'PATCH') return response({ id: path.split('/').at(-1), surface: 'memory', ...body });
    if (path.includes('/memories?')) return response({ items: [], total: 0, page: 1, total_pages: 1 });
    if (path.includes('/messages?')) return response({ items: [], total: 0, page: 1, total_pages: 1 });
    throw new Error(`未配置测试接口 ${method} ${path}`);
  }));
});
async function setup() { const view = render(<MemoryChat />); await screen.findByText(connected ? '服务已验证连接' : '尚未连接服务'); return view; }
function write(content = '我的偏好') { fireEvent.change(screen.getByLabelText('普通助手消息'), { target: { value: content } }); }
async function send(content) { write(content); fireEvent.click(screen.getByRole('button', { name: '发送' })); await screen.findByText('已整理为待确认候选。'); }

it('编号准备失败时保留普通助手草稿并释放锁，不提交会话或聊天接口', async () => {
  vi.stubGlobal('crypto', {});
  try {
    await setup(); write('尚未提交的内容'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('浏览器不支持生成消息编号');
    expect(screen.getByLabelText('普通助手消息')).toBeEnabled();
    expect(screen.getByLabelText('普通助手消息')).toHaveValue('尚未提交的内容');
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: '召回记忆' }));
    expect(screen.getByRole('tab', { name: '召回记忆' })).toHaveAttribute('aria-selected', 'true');
  } finally { vi.unstubAllGlobals(); }
});

it.each(['写入记忆', '召回记忆'])('HTTP 环境缺少 randomUUID 时%s仍提交聊天接口并释放操作锁', async mode => {
  const crypto = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  try {
    await setup();
    if (mode === '召回记忆') fireEvent.click(screen.getByRole('tab', { name: mode }));
    write('你的名字叫羊狗'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/chat'))).toHaveLength(1));
    expect(calls.find(call => call.path.endsWith('/chat')).body.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await screen.findByText('已整理为待确认候选。');
    await waitFor(() => expect(screen.getByLabelText('普通助手消息')).toBeEnabled());
    expect(screen.queryByRole('button', { name: '取消请求' })).not.toBeInTheDocument();
  } finally { vi.unstubAllGlobals(); }
});

it('空态不伪造记忆，示例只填入，未连接时打开普通助手连接表单', async () => {
  connected = false; await setup();
  fireEvent.click(screen.getByRole('button', { name: /我希望回答先给结论/ }));
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('我希望回答先给结论，再解释原因。');
  expect(calls.some(call => call.path.endsWith('/chat'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByRole('heading', { name: '记忆助手服务' })).toBeVisible();
  expect(screen.getByText(/当前账号自动关联独立的 MemoryOS 用户/)).toBeVisible();
  fireEvent.click(screen.getByLabelText('关闭连接设置'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('首次真实写入创建 memory 会话，IME 与换行不发送，Enter 发送并锁住重复请求', async () => {
  const pending = deferred(); route('POST', '/sessions/session-1/chat', () => pending.promise); await setup();
  write('我的偏好'); const input = screen.getByLabelText('普通助手消息');
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(bodies('/sessions')).toHaveLength(0);
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('button', { name: '取消请求' });
  expect(input).toBeDisabled(); expect(screen.getByRole('button', { name: '新会话测试召回' })).toBeDisabled();
  expect(bodies('/sessions')[0]).toMatchObject({ surface: 'memory', mode: 'training' });
  await waitFor(() => expect(bodies('/sessions/session-1/chat')).toHaveLength(1));
  expect(bodies('/sessions/session-1/chat')[0]).toMatchObject({ content: '我的偏好', pet_name: '记忆助手' });
  await act(async () => pending.resolve(response(reply)));
  expect(await screen.findByRole('region', { name: '待确认记忆' })).toBeVisible();
});

it('候选修正校验空值、保存失败保留编辑，再保存与拒绝均来自服务', async () => {
  await setup(); await send(); fireEvent.click(screen.getByRole('button', { name: '修正' }));
  const edit = screen.getByLabelText('修改候选内容');
  fireEvent.change(edit, { target: { value: '   ' } }); fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('记忆内容不能为空');
  expect(bodies('/sessions/session-1/candidates/candidate-1')).toHaveLength(0);
  fireEvent.change(edit, { target: { value: '用户希望先给结论，再解释原因' } });
  route('PATCH', '/sessions/session-1/candidates/candidate-1', () => response(null, false, '候选保存失败，请重试。'));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('候选保存失败'); expect(edit).toHaveValue('用户希望先给结论，再解释原因');
  route('PATCH', '/sessions/session-1/candidates/candidate-1', ({ body }) => response({ ...candidate(), ...body }));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(screen.queryByLabelText('修改候选内容')).not.toBeInTheDocument());
  expect(screen.getByText('用户希望先给结论，再解释原因')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '修正' }));
  fireEvent.change(screen.getByLabelText('修改候选内容'), { target: { value: '未保存' } });
  fireEvent.click(screen.getByRole('button', { name: '取消修改' }));
  fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
  expect(await screen.findByText('已忽略这条候选记忆')).toBeVisible();
  expect(bodies('/sessions/session-1/candidates/candidate-1').at(-1)).toEqual({ status: 'rejected' });
});

it('确认没有真实编号不得显示成功，重试确认后可查看真实长期记忆', async () => {
  await setup(); await send();
  route('POST', '/sessions/session-1/memories/confirm', () => response({ ...candidate(), status: 'confirmed', memory_ids: [] }));
  fireEvent.click(screen.getByRole('button', { name: '确认并写入' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('尚未返回真实记忆编号');
  expect(screen.queryByText('已写入 1 条长期记忆')).not.toBeInTheDocument();
  route('POST', '/sessions/session-1/memories/confirm', () => response({ ...candidate(), status: 'confirmed', memory_ids: ['memory-real-1'] }));
  route('GET', '/sessions/session-1/memories?page=1&limit=20&q=%E7%94%A8%E6%88%B7%E5%96%9C%E6%AC%A2%E5%85%88%E7%BB%99%E7%BB%93%E8%AE%BA', () => response({ items: [{ id: 'memory-real-1', content: '用户喜欢先给结论', source: '训练确认', status: 'active' }], total: 1 }));
  fireEvent.click(screen.getByRole('button', { name: '确认并写入' }));
  fireEvent.click(await screen.findByText('已写入 1 条长期记忆'));
  fireEvent.click(screen.getByLabelText('查看已写入记忆 memory-real-1'));
  const drawer = await screen.findByRole('complementary', { name: '长期记忆查看' });
  expect(await within(drawer).findByText('memory-real-1')).toBeVisible();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('complementary', { name: '长期记忆查看' })).not.toBeInTheDocument();
});

it('新召回会话清除聊天历史而不自动发请求，答案有可展开的真实召回证据', async () => {
  await setup(); await send();
  fireEvent.click(screen.getByRole('button', { name: '新会话测试召回' }));
  await screen.findByText('验证助手能否记起已写入的信息');
  expect(bodies('/sessions').at(-1)).toMatchObject({ surface: 'memory', mode: 'chat' });
  expect(calls.filter(call => call.path.endsWith('/chat'))).toHaveLength(1);
  expect(screen.queryByText('已整理为待确认候选。')).not.toBeInTheDocument();
  reply = { user_message: item('user-2', '我之前的偏好？', 'user'), assistant_message: item('assistant-2', '你希望先给结论，再解释原因。', 'assistant', { memories: [{ id: 'memory-real-1', content: '长期偏好正文', source: 'training_confirmation' }, { id: 'memory-real-1', content: '长期偏好正文', source: 'training_confirmation' }] }) };
  write('我之前的偏好？'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  const summary = await screen.findByText('引用 1 条记忆'); fireEvent.click(summary);
  expect(screen.getByText('长期偏好正文')).toBeVisible(); expect(screen.getByText('training_confirmation')).toBeVisible();
  expect(screen.queryByText('待确认记忆')).not.toBeInTheDocument();
});

it('失败重试保留同一 request_id 与完整内容，不重复显示用户消息', async () => {
  route('POST', '/sessions/session-1/chat', () => response(null, false, '模型暂不可用，请重试。'));
  await setup(); write('需要记住'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('模型暂不可用');
  const original = bodies('/sessions/session-1/chat')[0];
  routes.delete('POST /sessions/session-1/chat'); reply.user_message.content = '需要记住';
  fireEvent.click(screen.getByRole('button', { name: '重试消息' }));
  await screen.findByText('已整理为待确认候选。');
  expect(bodies('/sessions/session-1/chat')[1]).toEqual(original);
  expect(screen.getAllByText('需要记住')).toHaveLength(1);
});

it('取消后即使运输层迟到成功也不显示回答，重试仍用原幂等键', async () => {
  const pending = deferred(); route('POST', '/sessions/session-1/chat', () => pending.promise);
  await setup(); write('保留此消息'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(bodies('/sessions/session-1/chat')).toHaveLength(1));
  const original = bodies('/sessions/session-1/chat')[0];
  fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
  expect(calls.find(call => call.path.endsWith('/chat')).signal.aborted).toBe(true);
  await act(async () => pending.resolve(response(reply)));
  expect(await screen.findByRole('alert')).toHaveTextContent('请求已取消');
  expect(screen.queryByText('已整理为待确认候选。')).not.toBeInTheDocument();
  routes.delete('POST /sessions/session-1/chat'); fireEvent.click(screen.getByRole('button', { name: '重试消息' }));
  await screen.findByText('已整理为待确认候选。'); expect(bodies('/sessions/session-1/chat')[1]).toEqual(original);
});

it('失败消息与重试编号仅留在写入会话，返回后仍可幂等重试', async () => {
  route('POST', '/sessions/session-1/chat', () => response(null, false, '发送失败'));
  await setup(); write('应保留的失败消息'); fireEvent.click(screen.getByRole('button', { name: '发送' })); await screen.findByRole('alert');
  const original = bodies('/sessions/session-1/chat')[0];
  fireEvent.click(screen.getByRole('tab', { name: '召回记忆' }));
  expect(screen.getByRole('tab', { name: '召回记忆' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('');
  expect(screen.queryByText('应保留的失败消息')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重试消息' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '写入记忆' }));
  expect(screen.getByText('应保留的失败消息')).toBeVisible();
  routes.delete('POST /sessions/session-1/chat');
  fireEvent.click(screen.getByRole('button', { name: '重试消息' }));
  await screen.findByText('已整理为待确认候选。');
  expect(bodies('/sessions/session-1/chat')[1]).toEqual(original);
});

it('会话列表隔离普通助手并分页，历史默认加载最后一页、更早页去重前插', async () => {
  const history = { id: 'old', surface: 'memory', mode: 'chat', title: '历史验证', created_at: '2026-10-13' };
  route('GET', '/sessions?surface=memory&page=1&limit=20', () => response({ items: [history], total_pages: 2 }));
  route('GET', '/sessions?surface=memory&page=2&limit=20', () => response({ items: [{ ...history, id: 'old2', title: '第二页会话' }], total_pages: 2 }));
  route('GET', '/sessions/old/messages?page=1&limit=100', () => response({ items: [item('first', '第一页旧信息')], total_pages: 3 }));
  route('GET', '/sessions/old/messages?page=3&limit=100', () => response({ items: [item('latest', '最新消息')], total_pages: 3 }));
  route('GET', '/sessions/old/messages?page=2&limit=100', () => response({ items: [item('earlier', '较早消息'), item('latest', '最新消息')], total_pages: 3 }));
  await setup(); fireEvent.click(await screen.findByRole('button', { name: /历史验证/ }));
  await screen.findByText('最新消息'); expect(screen.queryByText('第一页旧信息')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看更早的消息' }));
  await screen.findByText('较早消息'); expect(screen.getAllByText('最新消息')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '查看更早的消息' })); await screen.findByText('第一页旧信息');
  expect(screen.queryByText('查看更早的消息')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('会话下一页')); await screen.findByText('第二页会话');
  fireEvent.click(screen.getByLabelText('会话上一页')); await screen.findByText('历史验证');
  fireEvent.click(screen.getByLabelText('展开会话列表')); expect(screen.getByLabelText('展开会话列表')).toHaveAttribute('aria-expanded', 'true');
});

it('长期记忆真实读取、搜索与分页；无记录显示空态，读取错误中文提示', async () => {
  route('GET', '/sessions/session-1/memories?page=1&limit=20&q=', () => response({ items: [{ id: 'm1', content: '真实服务记录' }], total: 21 }));
  route('GET', '/sessions/session-1/memories?page=2&limit=20&q=', () => response({ items: [{ id: 'm2', content: '第二页记录', source: '用户确认' }], total: 21 }));
  await setup(); fireEvent.click(screen.getByRole('button', { name: '查看长期记忆' }));
  await screen.findByText('真实服务记录'); expect(calls.some(call => call.path.endsWith('/chat'))).toBe(false);
  fireEvent.click(screen.getByLabelText('记忆下一页')); await screen.findByText('第二页记录');
  fireEvent.click(screen.getByLabelText('记忆上一页')); await screen.findByText('真实服务记录');
  fireEvent.change(screen.getByLabelText('搜索长期记忆'), { target: { value: '不存在' } }); fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await screen.findByText('没有找到已写入的记忆');
  route('GET', '/sessions/session-1/memories?page=1&limit=20&q=%E4%B8%8D%E5%AD%98%E5%9C%A8', () => response(null, false, '记忆读取失败'));
  fireEvent.click(screen.getByRole('button', { name: '搜索' })); expect(await screen.findByRole('alert')).toHaveTextContent('记忆读取失败');
  fireEvent.click(screen.getByLabelText('关闭长期记忆')); fireEvent.click(screen.getByLabelText('关闭错误提示'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('重连后清除旧会话，凭据只发送给后端、不写浏览器存储', async () => {
  await setup(); await send(); fireEvent.click(screen.getAllByRole('button', { name: '记忆服务' })[0]);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByLabelText('模型名称')).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText('API 地址')).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText('用户 ID')).not.toBeInTheDocument();
  expect(within(dialog).queryByLabelText('API Key')).not.toBeInTheDocument();
  route('POST', '/connection', () => response({ connected: true }));
  fireEvent.click(within(dialog).getByRole('button', { name: '重试连接' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(bodies('/connection')[0]).toEqual({}); expect(localStorage.length).toBe(0);
  expect(screen.queryByText('已整理为待确认候选。')).not.toBeInTheDocument();
  expect(screen.getByText('尚未开始对话')).toBeVisible();
});

it('卸载后的迟到聊天结果不进入新页面的新会话', async () => {
  const pending = deferred(); route('POST', '/sessions/session-1/chat', () => pending.promise);
  const view = await setup(); write('旧会话消息'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(bodies('/sessions/session-1/chat')).toHaveLength(1));
  view.unmount(); await setup(); await act(async () => pending.resolve(response(reply)));
  expect(screen.queryByText('已整理为待确认候选。')).not.toBeInTheDocument(); expect(screen.getByText('尚未开始对话')).toBeVisible();
});

it('拒绝宠物历史或错误 surface，列表和历史失败不会伪造成功', async () => {
  route('GET', '/sessions?surface=memory&page=1&limit=20', () => response({ items: [{ id: 'pet', title: '错误宠物会话', surface: 'pet', mode: 'training', created_at: '2026-10-14' }, { id: 'bad', title: '加载失败会话', surface: 'memory', mode: 'training', created_at: '2026-10-14' }] }));
  route('GET', '/sessions/bad/messages?page=1&limit=100', () => response(null, false, '读取历史失败'));
  await setup(); fireEvent.click(await screen.findByRole('button', { name: /错误宠物会话/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('不属于普通记忆页面');
  fireEvent.click(screen.getByRole('button', { name: /加载失败会话/ }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('读取历史失败'));
  route('POST', '/sessions', () => response({ id: 'wrong', surface: 'pet', mode: 'chat' }));
  fireEvent.click(screen.getByRole('button', { name: '新会话测试召回' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('会话类型不匹配'));
});

it('未建立会话可直接切模式，纯证据组件容忍空引用或缺少编号', async () => {
  await setup(); fireEvent.click(screen.getByRole('tab', { name: '召回记忆' }));
  expect(screen.getByRole('tab', { name: '召回记忆' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('button', { name: /我之前说过，希望你如何组织回答/ }));
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('我之前说过，希望你如何组织回答？');
  expect(bodies('/sessions')).toHaveLength(0); expect(memoryTime(null)).toBe('');
  const view = render(<MemoryEvidence memories={[]} />); view.rerender(<MemoryEvidence memories={[{ content: '缺少编号的服务证据' }]} />);
  fireEvent.click(screen.getByText('引用 1 条记忆')); expect(screen.getByText('未返回编号')).toBeVisible();
});

it('状态读取失败显示中文错误，仍可打开配置；列表请求失败不给虚假历史', async () => {
  route('GET', '/status', () => response(null, false, '服务状态读取失败'));
  render(<MemoryChat />); expect(await screen.findByRole('alert')).toHaveTextContent('服务状态读取失败');
  fireEvent.click(screen.getAllByRole('button', { name: '记忆服务' })[0]);
  expect(screen.getByRole('heading', { name: '记忆助手服务' })).toBeVisible();
});

it('会话列表错误、新会话错误与较早历史错误保留已有正文', async () => {
  route('GET', '/sessions?surface=memory&page=1&limit=20', () => response(null, false, '会话列表读取失败'));
  await setup(); expect(await screen.findByRole('alert')).toHaveTextContent('会话列表读取失败');
  route('POST', '/sessions', () => response(null, false, '新会话建立失败'));
  fireEvent.click(screen.getByRole('button', { name: '新写入会话' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('新会话建立失败'));
  expect(screen.getByText('尚未开始对话')).toBeVisible();
  routes.delete('POST /sessions');
  route('GET', '/sessions?surface=memory&page=1&limit=20', () => response({ items: [{ id: 'historic', mode: 'chat', title: '不完整历史', created_at: '2026-10-14' }] }));
  fireEvent.click(screen.getByRole('button', { name: '新写入会话' }));
  fireEvent.click(await screen.findByRole('button', { name: /不完整历史/ }));
  route('GET', '/sessions/historic/messages?page=1&limit=100', () => response({ items: [], total_pages: 2 }));
  route('GET', '/sessions/historic/messages?page=2&limit=100', () => response({ items: [item('new', '最新正文保留')], total_pages: 2 }));
  // 第一次点击已进入读取过程，等待结束后再加载受控历史。
  await waitFor(() => expect(screen.getByRole('button', { name: /不完整历史/ })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: /不完整历史/ })); await screen.findByText('最新正文保留');
  route('GET', '/sessions/historic/messages?page=1&limit=100', () => response(null, false, '更早消息读取失败'));
  fireEvent.click(screen.getByRole('button', { name: '查看更早的消息' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('更早消息读取失败'));
  expect(screen.getByText('最新正文保留')).toBeVisible();
});

it('取消确认不写成功；打开的真实记忆抽屉在确认成功后刷新', async () => {
  await setup(); await send();
  const pending = deferred(); route('POST', '/sessions/session-1/memories/confirm', () => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: '确认并写入' }));
  await screen.findByRole('button', { name: '取消请求' }); fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
  await act(async () => pending.resolve(response({ ...candidate(), status: 'confirmed', memory_ids: ['uncertain-id'] })));
  expect(await screen.findByRole('alert')).toHaveTextContent('请求已取消');
  expect(screen.queryByText('已写入 1 条长期记忆')).not.toBeInTheDocument();
  routes.delete('POST /sessions/session-1/memories/confirm');
  fireEvent.click(screen.getByRole('button', { name: '查看长期记忆' })); await screen.findByText('没有找到已写入的记忆');
  route('GET', '/sessions/session-1/memories?page=1&limit=20&q=', () => response({ items: [{ id: 'memory-real-1', content: '刚确认的真实记忆' }], total: 1 }));
  fireEvent.click(screen.getByRole('button', { name: '确认并写入' }));
  await screen.findByText('已写入 1 条长期记忆'); expect(await screen.findByText('刚确认的真实记忆')).toBeVisible();
});

it('跨模式新建会话保留原模式草稿，取消创建时不会安装迟到会话', async () => {
  const pending = deferred(); route('POST', '/sessions', () => pending.promise); await setup(); write('尚未发送的内容');
  fireEvent.click(screen.getByRole('button', { name: '新会话测试召回' }));
  fireEvent.click(await screen.findByRole('button', { name: '取消请求' }));
  await act(async () => pending.resolve(response({ id: 'late', surface: 'memory', mode: 'chat' })));
  expect(await screen.findByRole('alert')).toHaveTextContent('请求已取消');
  expect(screen.getByText('尚未开始对话')).toBeVisible();
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('尚未发送的内容');
  routes.delete('POST /sessions'); fireEvent.click(screen.getByRole('button', { name: '新会话测试召回' }));
  await screen.findByText('验证助手能否记起已写入的信息'); expect(screen.getByLabelText('普通助手消息')).toHaveValue('');
  fireEvent.click(screen.getByRole('tab', { name: '写入记忆' }));
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('尚未发送的内容');
});

it('重复选择当前模式与空白表单不发请求，未连接的长期记忆入口引导设置', async () => {
  connected = false; await setup();
  fireEvent.click(screen.getByRole('tab', { name: '写入记忆' }));
  fireEvent.submit(screen.getByLabelText('普通助手消息').closest('form'));
  expect(bodies('/sessions')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '查看长期记忆' }));
  expect(screen.getByRole('heading', { name: '记忆助手服务' })).toBeVisible();
});

it('确认编号为空字符串或类型不正确仍不能成功写入', async () => {
  await setup(); await send();
  route('POST', '/sessions/session-1/memories/confirm', () => response({ ...candidate(), status: 'confirmed', memory_ids: [null] }));
  fireEvent.click(screen.getByRole('button', { name: '确认并写入' })); await screen.findByRole('alert');
  expect(screen.queryByText('已写入 1 条长期记忆')).not.toBeInTheDocument();
  route('POST', '/sessions/session-1/memories/confirm', () => response({ ...candidate(), status: 'confirmed', memory_ids: ['  '] }));
  fireEvent.click(screen.getByRole('button', { name: '确认并写入' }));
  await waitFor(() => expect(bodies('/sessions/session-1/memories/confirm')).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认并写入' })).not.toBeDisabled());
  expect(screen.queryByText('已写入 1 条长期记忆')).not.toBeInTheDocument();
});


it('写入与召回消息隔离，各自恢复草稿、候选和会话编号', async () => {
  await setup(); await send('写入专属消息');
  write('写入草稿');
  fireEvent.click(screen.getByRole('tab', { name: '召回记忆' }));
  expect(screen.queryByText('已整理为待确认候选。')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '待确认记忆' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('');
  reply = { user_message: item('recall-u', '召回专属消息', 'user'), assistant_message: item('recall-a', '召回专属回复') };
  write('召回专属消息'); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('召回专属回复'); write('召回草稿');
  fireEvent.click(screen.getByRole('tab', { name: '写入记忆' }));
  expect(screen.getByText('已整理为待确认候选。')).toBeVisible();
  expect(screen.getByRole('region', { name: '待确认记忆' })).toBeVisible();
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('写入草稿');
  expect(screen.queryByText('召回专属回复')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '召回记忆' }));
  expect(screen.getByLabelText('普通助手消息')).toHaveValue('召回草稿');
  expect(screen.getByText('召回专属回复')).toBeVisible();
  expect(bodies('/sessions').map(body => body.mode)).toEqual(['training', 'chat']);
  expect(bodies('/sessions/session-1/chat')).toHaveLength(1);
  expect(bodies('/sessions/session-2/chat')).toHaveLength(1);
  expect(calls.some(call => call.method === 'PATCH' && /^\/sessions\/[^/]+$/.test(call.path))).toBe(false);
});
