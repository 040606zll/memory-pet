import { afterEach, expect, it, vi } from 'vitest';

// 此处检查真实代理规则，构建插件留给 build 验证，避免在 jsdom 中加载 esbuild。
vi.mock('vite', () => ({ defineConfig: config => config }));
vi.mock('@vitejs/plugin-react', () => ({ default: () => ({}) }));

// 使用不同于默认 /api 的发布地址，验证所有请求实际读取统一配置。
vi.mock('../src/config.js', () => ({ API_BASE_URL: 'https://pet.example.test/service/api/' }));
import { api, post, patch } from '../src/api.js';

afterEach(() => vi.unstubAllGlobals());

it('读取发布配置并统一拼接查询、提交、修改请求地址，保留请求体与取消信号', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { connected: true } }) }));
  vi.stubGlobal('fetch', fetchMock);
  const signal = new AbortController().signal;
  await expect(api('/sessions?page=2&limit=20')).resolves.toEqual({ connected: true });
  await post('/connection', { memoryos: { user_id: 'test-user' } }, signal);
  await patch('/sessions/test/candidates/item', { content: '喜欢雨声' });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    'https://pet.example.test/service/api/sessions?page=2&limit=20',
    'https://pet.example.test/service/api/connection',
    'https://pet.example.test/service/api/sessions/test/candidates/item',
  ]);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', signal, headers: { 'Content-Type': 'application/json' } });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ memoryos: { user_id: 'test-user' } });
  expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ content: '喜欢雨声' }) });
});

it('开发代理将公开 /pet-api 入口转换为真实后端 /api，保留业务路径与查询参数', async () => {
  const { default: config } = await import('../vite.config.mjs');
  const proxy = config.server.proxy['/pet-api'];
  expect(proxy.target).toBe('http://127.0.0.1:8797');
  expect(proxy.rewrite('/pet-api/auth/me')).toBe('/api/auth/me');
  expect(proxy.rewrite('/pet-api/sessions?surface=memory&page=2')).toBe('/api/sessions?surface=memory&page=2');
});
