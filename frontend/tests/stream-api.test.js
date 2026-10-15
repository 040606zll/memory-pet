vi.mock('../src/config.js', () => ({ API_BASE_URL: '/api' }));
import { expect, it, vi, beforeEach } from 'vitest';
import { streamChat, setApiSession, openAsrSocket, onSessionInvalidated } from '../src/api.js';
beforeEach(() => setApiSession('csrf-test'));
function sse(frames, chunkSize = 1) { const bytes = new TextEncoder().encode(frames); return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
it('handles fragmented Chinese UTF8, comments, multiple frames and terminal done', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse(': keepalive\n\nevent: delta\ndata: {"text":"你好🐶"}\n\nevent: voice_error\ndata: {"message":"稍后"}\n\nevent: done\ndata: {"answer":"好了"}\n\n')));
  const onEvent = vi.fn(); expect(await streamChat('/s/chat', {}, { voice: true, onEvent })).toEqual({ answer: '好了' }); expect(onEvent).toHaveBeenCalledWith('delta', { text: '你好🐶' });
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-CSRF-Token': 'csrf-test', 'X-Voice-Enabled': 'true', Accept: 'text/event-stream' });
});
it.each(['event: error\ndata: {"message":"失败"}\n\n', 'event: error\ndata: {}\n\n', 'event: delta\ndata: {bad}\n\n', ': missing done\n\n', 'x'.repeat(2 ** 20 + 1)])('rejects errors or incomplete streams (%#)', async frames => { vi.stubGlobal('fetch', vi.fn(async () => sse(frames, 65536))); await expect(streamChat('/s/chat', {})).rejects.toThrow(); });
it('accepts legacy JSON and rejects HTTP failures', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { ok: true } })))); expect(await streamChat('/s/chat', {})).toEqual({ ok: true });
  fetch.mockResolvedValueOnce(new Response('{"code":502,"message":"错误"}', { status: 502 })); await expect(streamChat('/s/chat', {})).rejects.toThrow('错误'); fetch.mockResolvedValueOnce(new Response('{"code":502}', { status: 502 })); await expect(streamChat('/s/chat', {})).rejects.toThrow('对话请求失败');
});
it('rejects stale accounts and invalidates current 401', async () => {
  const invalidated = vi.fn(); const unsubscribe = onSessionInvalidated(invalidated); vi.stubGlobal('fetch', vi.fn(async () => { setApiSession('new-account'); return sse(''); }));
  await expect(streamChat('/s/chat', {})).rejects.toMatchObject({ name: 'AbortError' }); fetch.mockResolvedValueOnce(new Response('{"code":401}', { status: 401 })); await expect(streamChat('/s/chat', {})).rejects.toThrow(); expect(invalidated).toHaveBeenCalledOnce(); unsubscribe();
});
it('checks cancellation between events; sends ASR CSRF without URL credentials', async () => {
  const controller = new AbortController(); vi.stubGlobal('fetch', vi.fn(async () => sse('event: delta\ndata: {"text":"你"}\n\nevent: done\ndata: {}\n\n'))); await expect(streamChat('/s/chat', {}, { signal: controller.signal, onEvent: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  class Socket { constructor(url) { this.url = url; } addEventListener(_, fn) { this.open = fn; } send = vi.fn(); close = vi.fn(); } vi.stubGlobal('WebSocket', Socket);
  const socket = openAsrSocket(); socket.open(); expect(socket.send).toHaveBeenCalledWith('{"csrf_token":"csrf-test"}'); expect(socket.url.pathname).toBe('/api/speech/asr'); expect(socket.url.search).toBe('');
  const stale = openAsrSocket(); setApiSession('new'); stale.open(); expect(stale.close).toHaveBeenCalledOnce();
});
it('handles CRLF split between byte chunks, optional callbacks and secure ASR URLs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => sse('event: delta\r\ndata: {"text":"你好"}\r\n\r\nevent: done\r\ndata: {"ok":true}\r\n\r\n')));
  expect(await streamChat('/s/chat', {})).toEqual({ ok: true });
  class Socket { constructor(url) { this.url = url; } addEventListener(_, fn) { this.open = fn; } send = vi.fn(); }
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('window', { location: { href: 'https://secure.test/' } });
  const socket = openAsrSocket(); expect(socket.url.protocol).toBe('wss:');
  vi.unstubAllGlobals();
});
it('preserves a completed reply if cancelling the response reader reports a transport failure', async () => {
  const releaseLock = vi.fn();
  const reader = { read: vi.fn(async () => ({ value: new TextEncoder().encode('event: done\ndata: {"ok":true}\n\n'), done: false })), cancel: vi.fn(async () => { throw new Error('transport closed'); }), releaseLock };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => reader } })));
  expect(await streamChat('/s/chat', {})).toEqual({ ok: true }); expect(releaseLock).toHaveBeenCalledOnce();
});
