import { afterEach, expect, it, vi } from 'vitest';
import { SpeechPlayer } from '../src/speechPlayer.js';
class AudioContextMock {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; this.sources = []; }
  resume = vi.fn(async () => {}); close = vi.fn(async () => {});
  createBuffer(c, size, rate) { return { duration: size / rate, getChannelData: () => this.channel = new Float32Array(size) }; }
  createBufferSource() { const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }; this.sources.push(source); return source; }
}
const packet = (values = [0, 32767, -32768]) => ({ pcm: btoa(String.fromCharCode(...new Uint8Array(new Int16Array(values).buffer))), sample_rate: 24000 });
afterEach(() => vi.useRealTimers());
it('decodes signed PCM, schedules adjacent buffers and freezes media time during network gaps', async () => {
  vi.useFakeTimers(); const player = new SpeechPlayer(vi.fn(), AudioContextMock); await player.unlock();
  player.push(packet(new Array(2400).fill(0))); player.push(packet(new Array(2400).fill(0)));
  expect(player.context.sources[0].start).toHaveBeenCalledWith(.04); expect(player.context.sources[1].start.mock.calls[0][0]).toBeCloseTo(.14);
  player.context.currentTime = .5; expect(player.playedMs()).toBeCloseTo(200); player.push(packet()); expect(player.context.sources[2].start).toHaveBeenCalledWith(.54);
  player.context.currentTime = .52; expect(player.playedMs()).toBeCloseTo(200); expect([...player.context.channel]).toEqual([0, 32767 / 32768, -1]);
  player.context.sources[0].onended(); expect(player.sources.size).toBe(2); player.stop(); player.stop(); expect(player.context.close).toHaveBeenCalledTimes(1);
  player.push(packet()); expect(player.context.sources).toHaveLength(3);
});
it('reveals words using device time, deduplicates cumulative timings and finishes trailing punctuation', async () => {
  vi.useFakeTimers(); const onText = vi.fn(); const player = new SpeechPlayer(onText, AudioContextMock); player.appendText('你好，朋友！'); player.push(packet(new Array(24000).fill(0)));
  const output = { sentence: { index: 0, words: [{ text: '你', begin_index: 0, begin_time: 100 }, { text: '好', begin_index: 1, begin_time: 400 }, { text: '，朋友', begin_index: 2, begin_time: 600 }, { text: 'not-in-text', begin_index: 99, begin_time: 999 }] } };
  player.timing(output); player.timing(output); expect(player.words.size).toBe(4); expect(onText).not.toHaveBeenCalled();
  player.context.currentTime = .2; await vi.advanceTimersByTimeAsync(30); expect(onText).toHaveBeenLastCalledWith('你');
  player.context.currentTime = .5; player.tick(); expect(onText).toHaveBeenLastCalledWith('你好'); player.context.currentTime = .8; player.tick(); expect(onText).toHaveBeenLastCalledWith('你好，朋友');
  player.timing({}); player.timing({ sentence: { words: [{ text: 1 }, { text: '', begin_time: NaN }] } });
  player.context.currentTime = 2; await player.finish(); expect(onText).toHaveBeenLastCalledWith('你好，朋友！'); player.stop(); player.tick();
});
it('waits for final samples and rejects cancellation or missing audio', async () => {
  vi.useFakeTimers(); const player = new SpeechPlayer(vi.fn(), AudioContextMock); await expect(player.finish()).rejects.toThrow('没有返回音频'); player.push(packet(new Array(2400).fill(0)));
  const controller = new AbortController(); const finish = player.finish(controller.signal); controller.abort(); const check = expect(finish).rejects.toMatchObject({ name: 'AbortError' }); await vi.advanceTimersByTimeAsync(40); await check;
  const done = player.finish(); player.context.currentTime = 1; await vi.advanceTimersByTimeAsync(40); await done; player.stop(); await expect(player.finish()).rejects.toMatchObject({ name: 'AbortError' });
});
it('handles unsupported audio, autoplay restrictions and corrupt PCM', async () => {
  expect(() => new SpeechPlayer(vi.fn(), null)).toThrow('不支持'); const player = new SpeechPlayer(vi.fn(), AudioContextMock); player.context.state = 'suspended'; await expect(player.unlock()).rejects.toThrow('未允许');
  expect(() => player.push({ pcm: '', sample_rate: 16000 })).toThrow('采样率'); expect(() => player.push({ pcm: btoa('1'), sample_rate: 24000 })).toThrow('不完整'); expect(() => player.push({ pcm: '', sample_rate: 24000 })).toThrow('不完整'); player.stop();
});
it('supports Safari AudioContext and treats close failures as completed cleanup', async () => {
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', class extends AudioContextMock { close = vi.fn(async () => { throw new Error('already closed'); }); });
  try { const player = new SpeechPlayer(vi.fn()); await player.unlock(); player.stop(); await Promise.resolve(); expect(player.stopped).toBe(true); }
  finally { vi.unstubAllGlobals(); }
});
it('maps normalized numbers, dates and Unicode back to the original streamed text across sentences', () => {
  const onText = vi.fn(), player = new SpeechPlayer(onText, AudioContextMock);
  player.appendText('🐶有100个苹果。今天是2026年。'); player.push(packet(new Array(24000).fill(0)));
  const first = { original_text: '🐶有100个苹果。', normalized_text: '🐶有一百个苹果。', sentence: { index: 0, words: [
    { text: '🐶', begin_index: 0, begin_time: 0 }, { text: '有', begin_index: 1, begin_time: 100 }, { text: '一', begin_index: 2, begin_time: 200 }, { text: '百', begin_index: 3, begin_time: 300 }, { text: '个苹果。', begin_index: 4, begin_time: 400 },
  ] } };
  player.timing(first); player.timing(first);
  player.context.currentTime = .25; player.tick(); expect(onText).toHaveBeenLastCalledWith('🐶有100');
  player.context.currentTime = .45; player.tick(); expect(onText).toHaveBeenLastCalledWith('🐶有100个苹果。');
  player.timing({ original_text: '今天是2026年。', normalized_text: '今天是二零二六年。', sentence: { index: 1, words: [{ text: '今天是', begin_index: 8, begin_time: 500 }, { text: '二', begin_index: 11, begin_time: 600 }, { text: '零二六年。', begin_index: 12, begin_time: 800 }, { text: '供应商未知词', begin_index: 99, begin_time: 999 }] } });
  player.context.currentTime = .65; player.tick(); expect(onText).toHaveBeenLastCalledWith('🐶有100个苹果。今天是2026');
  player.context.currentTime = .85; player.tick(); expect(onText).toHaveBeenLastCalledWith('🐶有100个苹果。今天是2026年。'); player.stop();
});
it('defers missing sentence metadata and handles normalized insertions without changing source text', () => {
  const onText = vi.fn(), player = new SpeechPlayer(onText, AudioContextMock);
  player.timing({ original_text: '不存在', normalized_text: '不存在', sentence: { index: 0, words: [] } });
  player.appendText('你好'); player.push(packet(new Array(24000).fill(0)));
  player.timing({ original_text: '你好', normalized_text: '你呀好', sentence: { index: 1, words: [{ text: '你', begin_time: 0 }, { text: '呀', begin_time: 100 }, { text: '好', begin_time: 200 }] } });
  player.context.currentTime = .15; player.tick(); expect(onText).toHaveBeenLastCalledWith('你');
  player.context.currentTime = .25; player.tick(); expect(onText).toHaveBeenLastCalledWith('你好'); player.stop();
});
it('does not reveal zero-timestamp text before the first PCM sample is actually scheduled to play', () => {
  const onText = vi.fn(), player = new SpeechPlayer(onText, AudioContextMock); player.appendText('你好');
  player.timing({ sentence: { index: 0, words: [{ text: '你', begin_time: 0 }] } }); expect(onText).not.toHaveBeenCalled();
  player.push(packet(new Array(2400).fill(0))); player.tick(); expect(onText).not.toHaveBeenCalled();
  player.context.currentTime = .04; player.tick(); expect(onText).toHaveBeenLastCalledWith('你'); player.stop();
});
