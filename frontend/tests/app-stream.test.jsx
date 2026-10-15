import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ options: null, resolve: null, reject: null, player: null, failUnlock: false, failConstruct: false }));
vi.mock('../src/RobotDog.jsx', () => ({ RobotDog: () => <div>测试宠物画布</div>, RobotDogAvatar: () => <span /> }));
vi.mock('../src/api.js', () => ({
  api: vi.fn(async path => path === '/status' ? { connected: true, speech: { configured: true } } : { total: 0 }),
  post: vi.fn(async () => ({ id: 'session' })), patch: vi.fn(),
  streamChat: vi.fn((path, body, options) => { state.options = options; return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))); }); }),
  openAsrSocket: vi.fn(),
}));
vi.mock('../src/speechPlayer.js', () => ({ SpeechPlayer: class {
  constructor(onText) { if (state.failConstruct) throw new Error('播放不可用'); state.player = this; this.onText = onText; this.text = ''; }
  unlock = vi.fn(async () => { if (state.failUnlock) throw new Error('请重新允许声音'); });
  appendText(text) { this.text += text; }
  push = vi.fn(); timing = vi.fn(); stop = vi.fn(); finish = vi.fn(async () => this.onText(this.text));
} }));
import { App } from '../src/App.jsx';
const answer = { user_message: { id: 'u', role: 'user', content: '你好' }, assistant_message: { id: 'a', role: 'assistant', content: '你好呀！', actions: [], memories: [{ id: 'm', content: '不应展示的私有记忆' }] } };
beforeEach(() => Object.assign(state, { options: null, resolve: null, player: null, failUnlock: false, failConstruct: false }));
async function send() { render(<App />); await screen.findByText('记忆已连接'); const input = screen.getByRole('textbox', { name: '训练消息' }); fireEvent.change(input, { target: { value: '你好' } }); fireEvent.submit(input.closest('form')); await waitFor(() => expect(state.options).toBeTruthy()); }
it('buffers streamed text until playback, routes PCM and timings and replaces temporary messages at completion', async () => {
  await send(); expect(state.options.voice).toBe(true);
  await act(async () => { state.options.onEvent('delta', { text: '你好呀！' }); state.options.onEvent('audio', { pcm: 'AAA=' }); state.options.onEvent('timing', { sentence: {} }); });
  expect(screen.queryByText('你好呀！')).not.toBeInTheDocument(); expect(state.player.push).toHaveBeenCalledWith({ pcm: 'AAA=' });
  act(() => state.player.onText('你')); expect(screen.getByText('你', { exact: true })).toBeInTheDocument();
  await act(async () => state.resolve(answer)); await waitFor(() => expect(screen.getByRole('textbox', { name: '训练消息' })).toBeEnabled());
  expect(document.querySelectorAll('.message-row.assistant')).toHaveLength(1); expect(screen.queryByText(/用到记忆/)).not.toBeInTheDocument(); expect(state.player.finish).toHaveBeenCalled(); expect(state.player.stop).toHaveBeenCalled();
});
it('falls back to streamed text after TTS failure and preserves the successful reply', async () => {
  await send(); await act(async () => { state.options.onEvent('delta', { text: '你好' }); state.options.onEvent('voice_error', { message: '语音暂不可用' }); state.options.onEvent('delta', { text: '呀！' }); });
  expect(screen.getByText('你好呀！')).toBeInTheDocument(); expect(screen.getByText('语音暂不可用')).toBeInTheDocument();
  await act(async () => state.resolve(answer)); expect(state.player.finish).not.toHaveBeenCalled();
});
it('cancels the network and queued audio immediately, with an idempotent retry entry', async () => {
  await send(); await act(async () => state.options.onEvent('delta', { text: '你' })); fireEvent.click(screen.getByRole('button', { name: '取消本次对话' }));
  await screen.findByText('本次对话已取消。你可以重试这条消息。'); expect(state.player.stop).toHaveBeenCalled(); expect(state.options.signal.aborted).toBe(true); expect(screen.getByRole('button', { name: '重试' })).toBeEnabled(); expect(document.querySelector('.message-row.assistant')).toBeNull();
  act(() => state.player.onText('取消后的迟到字幕'));
  expect(screen.queryByText('取消后的迟到字幕')).toBeNull();
});
it('continues in text when autoplay is blocked and ignores audio-only events without a player', async () => {
  state.failUnlock = true; await send(); expect(state.options.voice).toBe(false);
  await act(async () => {
    state.options.onEvent('audio', { pcm: 'AAA=' }); state.options.onEvent('timing', { sentence: {} });
    state.options.onEvent('metadata', {}); state.options.onEvent('delta', { text: '你好呀！' });
  });
  expect(screen.getByText('你好呀！')).toBeInTheDocument(); await act(async () => state.resolve(answer));
});
it('player construction failures preserve the unsent draft and release the request lock', async () => {
  state.failConstruct = true;
  render(<App />); await screen.findByText('记忆已连接');
  const input = screen.getByLabelText('训练消息'); fireEvent.change(input, { target: { value: '你好' } });
  fireEvent.submit(input.closest('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('播放不可用');
  expect(input).toBeEnabled(); expect(input).toHaveValue('你好'); expect(state.options).toBeNull();
});
it('releases playback and request when the account view unmounts', async () => {
  const view = render(<App />); await screen.findByText('记忆已连接'); const input = screen.getByRole('textbox', { name: '训练消息' }); fireEvent.change(input, { target: { value: '你好' } }); fireEvent.submit(input.closest('form')); await waitFor(() => expect(state.options).toBeTruthy()); view.unmount(); expect(state.options.signal.aborted).toBe(true); expect(state.player.stop).toHaveBeenCalled();
});
