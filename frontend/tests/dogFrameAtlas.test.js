import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/dogSpriteAssets.js', async original => ({ ...await original(), loadDogSprites: (...args) => mock.load(...args) }));
import { bakeDogFrames, dogFramePose, loadCoherentDogSprites } from '../src/dogFrameAtlas.js';
import { SPRITE_DURATIONS } from '../src/dogSpriteAssets.js';

let bitmap, source;
beforeEach(() => {
  class Shape { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }
  vi.stubGlobal('Path2D', Shape);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => Object.fromEntries(['clip', 'drawImage', 'clearRect', 'save', 'restore', 'translate', 'rotate', 'fill', 'beginPath', 'ellipse'].map(name => [name, vi.fn()])));
  bitmap = { close: vi.fn() }; vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
  source = { manifest: { actions: { blink: { frames: Array.from({ length: 16 }, (_, index) => ({ x: index * 280, y: 0, width: 272, height: 288, anchorX: 117.5, anchorY: 285 })) } } }, images: { blink: {} }, release: vi.fn() };
  mock.load.mockReset().mockResolvedValue(source);
});

it('所有动作从同一中立部件姿态出发并返回，不使用尺寸或透明度变化', () => {
  for (const name of Object.keys(SPRITE_DURATIONS)) {
    expect(dogFramePose(name, 0)).toEqual(dogFramePose('idle', 0));
    expect(dogFramePose(name, 1)).toEqual(dogFramePose('idle', 0));
    expect(Object.keys(dogFramePose(name, .5))).toEqual(['headAngle', 'headY', 'tailAngle', 'pawAngle', 'pawX', 'eye']);
  }
});
it('九个动作共享一张去重图集，首尾与待机使用同一物理帧，释放不会重复关闭', async () => {
  const assets = await bakeDogFrames(source, new AbortController().signal), idle = assets.manifest.actions.idle.frames[0];
  expect(assets.manifest.uniqueFrames).toBeGreaterThan(100);
  expect(assets.manifest.decodedBytes).toBeLessThan(80 * 1024 * 1024);
  expect(new Set(Object.values(assets.images))).toEqual(new Set([bitmap]));
  for (const [name, clip] of Object.entries(assets.manifest.actions)) {
    expect(clip.frames[0]).toEqual(idle); expect(clip.frames.at(-1)).toEqual(idle);
    expect(clip.frames).toHaveLength(name === 'idle' ? 1 : Math.ceil(SPRITE_DURATIONS[name] * 30 / 1000) + 1);
    expect(new Set(clip.frames.map(frame => frame.width + ':' + frame.height)).size).toBe(1);
  }
  assets.release(); assets.release(); expect(bitmap.close).toHaveBeenCalledOnce();
});
it('正式加载只读取眨眼源图，烘焙成功后立即释放源图', async () => {
  const signal = new AbortController().signal, assets = await loadCoherentDogSprites(signal);
  expect(mock.load).toHaveBeenCalledWith(signal, { only: ['blink'] }); expect(source.release).toHaveBeenCalledOnce(); assets.release();
});
it('取消、解码失败和解码后取消均清理素材，不交付半套动画', async () => {
  const before = new AbortController(); before.abort();
  await expect(loadCoherentDogSprites(before.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(source.release).toHaveBeenCalledOnce();
  vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('解码失败'));
  await expect(loadCoherentDogSprites(new AbortController().signal)).rejects.toThrow('解码失败');
  const after = new AbortController(); vi.mocked(createImageBitmap).mockImplementationOnce(async () => { after.abort(); return bitmap; });
  await expect(loadCoherentDogSprites(after.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(bitmap.close).toHaveBeenCalledOnce();
});
it('30帧每秒下头部没有高频反向跳动，位移和转角有明确上限', () => {
  for (const [name, duration] of Object.entries(SPRITE_DURATIONS)) {
    const count = Math.ceil(duration * 30 / 1000); let previous = dogFramePose(name, 0);
    for (let index = 1; index <= count; index++) {
      const pose = dogFramePose(name, index / count);
      expect(Math.abs(pose.headAngle)).toBeLessThanOrEqual(.045);
      expect(Math.abs(pose.headY - previous.headY)).toBeLessThan(.6);
      expect(Math.abs(pose.headAngle - previous.headAngle)).toBeLessThan(.015);
      expect(pose.eye).toBeGreaterThanOrEqual(0); expect(pose.eye).toBeLessThanOrEqual(1);
      previous = pose;
    }
  }
});
