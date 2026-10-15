import { vi } from 'vitest';
export const instances = [];
export class Rive {
  constructor(options) {
    this.options = options; this.playing = true;
    this.action = { value: 0 }; this.perform = { trigger: vi.fn() };
    this.viewModelInstance = { number: name => name === 'action' ? this.action : null, trigger: name => name === 'perform' ? this.perform : null };
    this.resizeDrawingSurfaceToCanvas = vi.fn();
    this.play = vi.fn(() => { this.playing = true; });
    this.pause = vi.fn(() => { this.playing = false; });
    this.cleanup = vi.fn(() => { this.playing = false; });
    instances.push(this);
    queueMicrotask(() => { if (!this.cleanup.mock.calls.length) options.onLoad(); });
  }
  advance() { if (this.playing) this.options.onAdvance(); }
}
export class Layout { constructor(options) { this.options = options; } }
export const Fit = { Contain: 'contain' }, Alignment = { BottomCenter: 'bottom-center' };
export const RuntimeLoader = { wasmUrl: '', fallbackUrl: undefined, setWasmUrl: vi.fn(url => { RuntimeLoader.wasmUrl = url; }), setWasmFallbackUrl: vi.fn(url => { RuntimeLoader.fallbackUrl = url; }) };
