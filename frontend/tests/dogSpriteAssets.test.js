import { beforeEach, expect, it, vi } from 'vitest';
import { loadDogSprites, SPRITE_DURATIONS, validateClip } from '../src/dogSpriteAssets.js';
let manifest, bitmaps;
beforeEach(() => {
  const frames = Array.from({ length: 16 }, (_, i) => ({ x: i * 10, y: 0, width: 200, height: 280, anchorX: 100, anchorY: 270 }));
  manifest = { actions: Object.fromEntries(Object.keys(SPRITE_DURATIONS).map(name => [name, { src: `${name}.png`, duration_ms: 1600, referenceHeight: 280, referenceWidth: 240, frames, sequence: [0, 1, 0] }])) };
  bitmaps = []; vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => manifest, blob: async () => ({ url }) })));
  vi.stubGlobal('createImageBitmap', vi.fn(async () => { const bitmap = { width: 1254, height: 1254, close: vi.fn() }; bitmaps.push(bitmap); return bitmap; }));
});
it('全部九动作解码完成才交付，释放图像仅一次', async () => {
  const assets = await loadDogSprites(new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(10); expect(createImageBitmap).toHaveBeenCalledTimes(9);
  expect(Object.keys(assets.images)).toHaveLength(9); assets.release(); assets.release();
  bitmaps.forEach(bitmap => expect(bitmap.close).toHaveBeenCalledOnce());
});
it('某动作加载失败释放其他已解码资源，不切换到半套素材', async () => {
  fetch.mockImplementation(async url => ({ ok: url !== 'wave.png', json: async () => manifest, blob: async () => ({}) }));
  await expect(loadDogSprites(new AbortController().signal)).rejects.toThrow('wave');
  expect(bitmaps).toHaveLength(8); bitmaps.forEach(bitmap => expect(bitmap.close).toHaveBeenCalledOnce());
});
it('配置缺少动作或加载失败明确报错，不开始播放', async () => {
  fetch.mockResolvedValueOnce({ ok: false }); await expect(loadDogSprites(new AbortController().signal)).rejects.toThrow('配置加载失败');
  delete manifest.actions.idle; await expect(loadDogSprites(new AbortController().signal)).rejects.toThrow('素材不完整');
});
it('取消中途加载会关闭所有已解码图像', async () => {
  const controller = new AbortController(); createImageBitmap.mockImplementation(async () => { const bitmap = { width: 1254, height: 1254, close: vi.fn() }; bitmaps.push(bitmap); controller.abort(); return bitmap; });
  await expect(loadDogSprites(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  bitmaps.forEach(bitmap => expect(bitmap.close).toHaveBeenCalledOnce());
});
it('越界/缺帧/非法锚点和非法播放序列均被阻止，已创建位图释放', async () => {
  const image = { width: 1254, height: 1254 }, clip = manifest.actions.idle;
  expect(() => validateClip('idle', { ...clip, frames: [] }, image)).toThrow('不完整');
  expect(() => validateClip('idle', { ...clip, sequence: [16] }, image)).toThrow('顺序');
  clip.frames[0] = { ...clip.frames[0], x: 1250 };
  await expect(loadDogSprites(new AbortController().signal)).rejects.toThrow('边界');
  bitmaps.forEach(bitmap => expect(bitmap.close).toHaveBeenCalledOnce());
});
