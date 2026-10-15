import { beforeEach, expect, it, vi } from 'vitest';
import { DogSpriteRenderer, SpriteClock, spriteFrame, spriteGeometry } from '../src/dogSpritePlayer.js';
const makeClip = () => ({ duration_ms: 1600, referenceHeight: 280, referenceWidth: 260, frames: Array.from({ length: 16 }, (_, index) => ({ x: index * 10, y: 0, width: 240, height: 290, anchorX: 110, anchorY: 284 })) });
const assets = { manifest: { actions: { idle: makeClip(), wave: { ...makeClip(), sequence: [0, 1, 2, 1, 0] } } }, images: { idle: {}, wave: {} } };
let canvas, rect, contexts;
beforeEach(() => {
  rect = { width: 320, height: 350 }; contexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const ctx = { fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })), clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: [0, 0, 0, 255] })) }; contexts.push(ctx); return ctx;
  });
  canvas = document.createElement('canvas'); canvas.getBoundingClientRect = () => rect;
});
it('按真实时间选择不同源图片帧，遵循回中立序列而不形变', () => {
  expect(spriteFrame(assets, { name: 'idle' }, 100).index).toBe(0);
  expect(spriteFrame(assets, { name: 'idle' }, 1600).index).toBe(0);
  expect(spriteFrame(assets, { name: 'wave', started: 0, progress: .5 }, 800).index).toBe(2);
  expect(spriteFrame(assets, { name: 'wave', started: 0, progress: 1 }, 1600).index).toBe(0);
  expect(spriteFrame(assets, { name: 'not_supported' }, 0).name).toBe('idle');
});
it('脚底锚点固定，变宽的尾巴不会导致整只狗随每帧缩放', () => {
  const first = spriteFrame(assets, { name: 'idle' }, 0), wider = { ...first, frame: { ...first.frame, width: 250, anchorY: 270 } };
  const a = spriteGeometry(first, 200, 350), b = spriteGeometry(wider, 200, 350);
  expect(a.width / first.frame.width).toBe(b.width / wider.frame.width);
  expect(a.y + first.frame.anchorY * a.height / first.frame.height).toBeCloseTo(350);
  expect(b.y + wider.frame.anchorY * b.height / wider.frame.height).toBeCloseTo(350);
});
it('暂停和后台间隔不会追赶跳帧，恢复第一时刻冻结活动时钟', () => {
  const clock = new SpriteClock(); expect(clock.advance(100)).toBe(0); expect(clock.advance(116)).toBe(16);
  clock.pause(); expect(clock.advance(20000)).toBe(16); expect(clock.advance(20016)).toBe(32);
  expect(clock.advance(60000)).toBe(96); expect(clock.advance(50000)).toBe(96);
});
it('可见画布不先清空，帧完成后一次提交，帧内不重载或重新分配尺寸', () => {
  const player = new DogSpriteRenderer(canvas, { diagnose: true });
  const first = spriteFrame(assets, { name: 'idle' }, 0); player.draw(first, 0);
  expect(contexts[0].clearRect).not.toHaveBeenCalled(); expect(contexts[0].drawImage).toHaveBeenCalledTimes(1);
  expect(contexts[1].drawImage.mock.calls[0].slice(1, 5)).toEqual([0, 0, 240, 290]);
  expect(player.draw(first, 16)).toBe(false);
  player.draw(spriteFrame(assets, { name: 'wave', started: 100, progress: .5 }, 100), 100);
  expect(player.stats).toEqual({ frames: 2, sourceFrames: 2, blankFrames: 0, resizes: 1 });
});
it('动作切换与恢复只提交一张完整帧，不交叉叠加旧脸和新脸', () => {
  const player = new DogSpriteRenderer(canvas); player.draw(spriteFrame(assets, { name: 'idle' }, 0), 0);
  player.draw(spriteFrame(assets, { name: 'wave', started: 16, progress: 0 }, 16), 16);
  expect(contexts).toHaveLength(2);
  expect(contexts[1].drawImage).toHaveBeenCalledTimes(2);
  expect(contexts[1].globalAlpha).toBe(1);
  player.draw(spriteFrame(assets, { name: 'wave', started: 16, progress: .5 }, 800), 800);
  player.resume(); player.draw(spriteFrame(assets, { name: 'idle' }, 800), 800);
  expect(contexts[1].drawImage).toHaveBeenCalledTimes(4);
  expect(contexts[1].globalAlpha).toBe(1);
  expect(contexts[0].clearRect).not.toHaveBeenCalled();
});
it('零尺寸保留已画帧，非整数相同像素尺寸不重复resize', () => {
  const player = new DogSpriteRenderer(canvas); const first = spriteFrame(assets, { name: 'idle' }, 0);
  player.draw(first, 0); rect = { width: 0, height: 0 }; expect(player.draw(first, 100)).toBe(false);
  expect(canvas.width).toBe(320); rect = { width: 320.1, height: 350.1 }; player.draw(first, 120);
  expect(player.stats.resizes).toBe(1); rect = { width: 330, height: 350 }; player.draw(first, 140);
  expect(player.stats.resizes).toBe(2); player.dispose(); expect(player.buffer.width).toBe(0);
});
it('从冻结动作恢复时先显示冻结帧，再沿完整图片序列回到中立，不做透明淡化', () => {
  const player = new DogSpriteRenderer(canvas), pose = spriteFrame(assets, { name: 'wave', started: 0, progress: .5 }, 0);
  player.draw(pose, 0); player.resume(); const idle = spriteFrame(assets, { name: 'idle' }, 0);
  player.draw(idle, 1000); expect(player.lastSample.frame).toBe(pose.frame);
  player.draw(idle, 1034); expect(player.lastSample.index).toBe(pose.index - 1);
  player.draw(idle, 1500); expect(player.lastSample.frame).toBe(idle.frame); expect(player.recovery).toBeNull();
  expect(contexts[1].globalAlpha).toBe(1);
});
it('诊断真实空白像素，Canvas不可用时提供中文错误', () => {
  const player = new DogSpriteRenderer(canvas, { diagnose: true }); contexts[0].getImageData.mockReturnValue({ data: [0, 0, 0, 0] });
  player.draw(spriteFrame(assets, { name: 'idle' }, 0), 0); expect(player.stats.blankFrames).toBe(1);
  canvas.getContext = () => null; expect(() => new DogSpriteRenderer(canvas)).toThrow('浏览器');
});
