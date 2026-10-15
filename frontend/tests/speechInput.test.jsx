import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ socket: null }));
vi.mock('../src/api.js', () => ({ openAsrSocket: () => state.socket }));
import { SpeechInput } from '../src/SpeechInput.jsx';
let props, tracks, context, node, media;
class Context {
  constructor() { context = this; this.destination = {}; this.audioWorklet = { addModule: vi.fn(async () => {}) }; }
  resume = vi.fn(async () => {}); close = vi.fn(async () => {});
  createMediaStreamSource() { return this.source = { connect: vi.fn(), disconnect: vi.fn() }; }
}
class Node { constructor() { node = this; this.port = { postMessage: vi.fn() }; } connect = vi.fn(); disconnect = vi.fn(); }
beforeEach(() => {
  props = { value: '草稿：', onChange: vi.fn(), onError: vi.fn(), onActive: vi.fn() }; tracks = [{ stop: vi.fn() }]; media = vi.fn(async () => ({ getTracks: () => tracks })); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: media } });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Node); vi.stubGlobal('WebSocket', { OPEN: 1 }); state.socket = { send: vi.fn(), close: vi.fn(), readyState: 1, bufferedAmount: 0 };
});
async function start() { fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); await waitFor(() => expect(state.socket.onmessage).toBeDefined()); }
async function event(data) { await act(async () => state.socket.onmessage({ data: JSON.stringify(data) })); }
it('streams PCM, revises transcripts and flushes final audio before finish', async () => {
  render(<SpeechInput {...props} />); await start(); await event({ type: 'ready' }); await event({ type: 'transcript', sentence_id: 1, text: '你' }); await event({ type: 'transcript', sentence_id: 1, text: '你好', final: true }); await event({ type: 'transcript', sentence_id: 2, text: '呀' }); expect(props.onChange).toHaveBeenLastCalledWith('草稿：你好呀');
  act(() => node.port.onmessage({ data: new ArrayBuffer(3200) })); expect(state.socket.send).toHaveBeenCalledWith(expect.any(ArrayBuffer)); fireEvent.click(screen.getByRole('button', { name: '停止语音输入' })); expect(tracks[0].stop).toHaveBeenCalled(); expect(node.port.postMessage).toHaveBeenCalledWith('flush');
  act(() => node.port.onmessage({ data: new ArrayBuffer(20) })); expect(state.socket.send).not.toHaveBeenCalledWith('{"type":"finish"}'); act(() => node.port.onmessage({ data: { finished: true } })); expect(state.socket.send).toHaveBeenLastCalledWith('{"type":"finish"}'); await event({ type: 'finished' }); expect(screen.getByRole('button', { name: '开始语音输入' })).toBeEnabled(); expect(props.onError).not.toHaveBeenCalled(); expect(props.onActive).toHaveBeenLastCalledWith(false);
});
it('releases late microphone permission results after unmount', async () => {
  let resolve; media.mockImplementation(() => new Promise(r => { resolve = r; })); const view = render(<SpeechInput {...props} />); fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); await waitFor(() => expect(resolve).toBeDefined()); view.unmount(); await act(async () => resolve({ getTracks: () => tracks })); expect(tracks[0].stop).toHaveBeenCalled(); expect(context.close).toHaveBeenCalled();
});
it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'UnknownError'])('reports microphone error %s', async name => {
  media.mockRejectedValue(Object.assign(new Error(), { name })); render(<SpeechInput {...props} />); fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); await waitFor(() => expect(props.onError).toHaveBeenCalled()); expect(screen.getByRole('button', { name: '开始语音输入' })).toBeEnabled();
});
it('handles unsupported APIs and cancels while connecting', async () => {
  vi.stubGlobal('AudioWorkletNode', undefined); const view = render(<SpeechInput {...props} />); fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('HTTPS')); vi.stubGlobal('AudioWorkletNode', Node); view.rerender(<SpeechInput {...props} />); await start(); fireEvent.click(screen.getByRole('button', { name: '停止语音输入' })); expect(state.socket.close).toHaveBeenCalled();
});
it.each(['error', 'close', 'malformed', 'provider', 'slow'])('releases devices on %s', async type => {
  render(<SpeechInput {...props} />); await start(); await event({ type: 'ready' }); await act(async () => {
    if (type === 'error') state.socket.onerror(); if (type === 'close') state.socket.onclose(); if (type === 'malformed') state.socket.onmessage({ data: '{bad' }); if (type === 'provider') state.socket.onmessage({ data: '{"type":"error","message":"暂不可用"}' }); if (type === 'slow') { state.socket.bufferedAmount = 128001; node.port.onmessage({ data: new ArrayBuffer(3200) }); }
  }); expect(props.onError).toHaveBeenCalled(); expect(tracks[0].stop).toHaveBeenCalled(); expect(context.close).toHaveBeenCalled(); expect(screen.getByRole('button', { name: '开始语音输入' })).toBeEnabled();
});

it('times out connection startup without leaving a microphone track open', async () => {
  vi.useFakeTimers();
  try {
    render(<SpeechInput {...props} />); await act(async () => fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })));
    await act(async () => vi.advanceTimersByTimeAsync(15001)); expect(props.onError).toHaveBeenCalledWith('语音连接超时，请重试。'); expect(tracks[0].stop).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it('automatically stops at 55 seconds and releases a stalled final result', async () => {
  vi.useFakeTimers();
  try {
    render(<SpeechInput {...props} />); await act(async () => fireEvent.click(screen.getByRole('button', { name: '开始语音输入' }))); await event({ type: 'ready' });
    await act(async () => vi.advanceTimersByTimeAsync(55001)); expect(screen.getByRole('button', { name: '正在完成识别' })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(12001)); expect(props.onError).toHaveBeenCalledWith('语音识别结束超时，请重试。'); expect(context.close).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it('does not request microphone access if startup is cancelled while AudioContext resumes', async () => {
  let resolve; vi.stubGlobal('AudioContext', class extends Context { resume = vi.fn(() => new Promise(r => { resolve = r; })); });
  render(<SpeechInput {...props} />); fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); fireEvent.click(screen.getByRole('button', { name: '停止语音输入' })); await act(async () => resolve()); expect(media).not.toHaveBeenCalled();
});
it('ignores late module/socket events, applies PCM backpressure only to the active recorder and preserves draft length', async () => {
  render(<SpeechInput {...props} />); await start(); const old = state.socket;
  await event({ type: 'ready' }); await event({ type: 'transcript', sentence_id: 1, text: '字'.repeat(5000) }); expect(props.onChange.mock.calls.at(-1)[0]).toHaveLength(4096);
  old.readyState = 0; act(() => node.port.onmessage({ data: new ArrayBuffer(20) })); expect(old.send).not.toHaveBeenCalled(); await event({ type: 'other' });
  await event({ type: 'finished' }); await act(async () => { old.onerror(); old.onclose(); old.onmessage({ data: '{}' }); node.port.onmessage({ data: new ArrayBuffer(20) }); }); expect(props.onError).not.toHaveBeenCalled();
});
it('supports injected capture and Safari AudioContext, prevents duplicate startup and catches close rejection', async () => {
  vi.stubGlobal('AudioContext', undefined); vi.stubGlobal('webkitAudioContext', class extends Context { close = vi.fn(async () => { throw new Error('already closed'); }); });
  const injected = vi.fn(async () => ({ getTracks: () => tracks }));
  const view = render(<SpeechInput {...props} getMedia={injected} />);
  const button = screen.getByRole('button', { name: '开始语音输入' });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  expect(injected).toHaveBeenCalledTimes(1); expect(media).not.toHaveBeenCalled();
  await event({ type: 'finished' }); expect(props.onError).not.toHaveBeenCalled();
  view.rerender(<SpeechInput {...props} disabled />); expect(screen.getByRole('button', { name: '开始语音输入' })).toBeDisabled();
});
it('cancels a pending worklet module load and ignores its late result', async () => {
  let resolve;
  vi.stubGlobal('AudioContext', class extends Context { constructor() { super(); this.audioWorklet.addModule = () => new Promise(r => { resolve = r; }); } });
  render(<SpeechInput {...props} />); fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '停止语音输入' })); await act(async () => resolve()); expect(state.socket.onmessage).toBeUndefined(); expect(tracks[0].stop).toHaveBeenCalled();
});
it('ignores a late microphone rejection after cancellation', async () => {
  let reject; media.mockImplementation(() => new Promise((_, r) => { reject = r; }));
  render(<SpeechInput {...props} />); fireEvent.click(screen.getByRole('button', { name: '开始语音输入' })); await waitFor(() => expect(reject).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: '停止语音输入' })); await act(async () => reject(new Error('late denial'))); expect(props.onError).not.toHaveBeenCalled();
});
