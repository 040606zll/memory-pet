import { beforeEach, expect, it, vi } from 'vitest';
let Processor;
beforeEach(async () => {
  vi.resetModules(); vi.stubGlobal('AudioWorkletProcessor', class { constructor() { this.port = { postMessage: vi.fn() }; } });
  vi.stubGlobal('registerProcessor', (name, value) => { expect(name).toBe('pcm-capture'); Processor = value; }); vi.stubGlobal('sampleRate', 48000); await import('../src/pcm-capture.worklet.js');
});
it.each([16000, 44100, 48000, 96000])('resamples %i Hz across render frames with exact PCM16 duration', rate => {
  vi.stubGlobal('sampleRate', rate); const p = new Processor(); for (let offset = 0; offset < rate; offset += 128) p.process([[new Float32Array(Math.min(128, rate - offset)).fill(.5)]]); p.port.onmessage();
  const buffers = p.port.postMessage.mock.calls.map(c => c[0]).filter(c => c instanceof ArrayBuffer); expect(buffers.reduce((sum, b) => sum + b.byteLength, 0)).toBe(32000); expect([...new Int16Array(buffers[0])].every(v => v === 16384)).toBe(true);
});
it('clamps PCM and acknowledges flush with or without pending samples', () => {
  vi.stubGlobal('sampleRate', 16000); const p = new Processor(); p.process([]); p.process([[new Float32Array([-2, 2])]]); p.port.onmessage(); expect([...new Int16Array(p.port.postMessage.mock.calls[0][0])]).toEqual([-32768, 32767]); expect(p.port.postMessage).toHaveBeenLastCalledWith({ finished: true });
  const count = p.port.postMessage.mock.calls.length; expect(p.process([[new Float32Array(16000)]])).toBe(true); expect(p.port.postMessage).toHaveBeenCalledTimes(count); const empty = new Processor(); empty.port.onmessage(); expect(empty.port.postMessage).toHaveBeenCalledOnce();
});
