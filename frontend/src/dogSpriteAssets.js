export const SPRITE_MANIFEST = '/assets/robot-dog-sprites-v1/manifest.json';
export const SPRITE_DURATIONS = { idle: 1600, blink: 800, wave: 1600, nod: 1600, shake_head: 1600, stretch: 2000, happy: 1600, sleep: 2400, wag_tail: 1200 };

/** 图集元数据与像素边界严格匹配，不能靠越界裁切掩盖缺失或坏帧。 */
export function validateClip(name, clip, image) {
  if (!clip || !Array.isArray(clip.frames) || clip.frames.length < 16 || !(clip.referenceHeight > 0) || !(clip.referenceWidth > 0) || !(clip.duration_ms > 0)) throw new Error(`机器狗${name}动作帧配置不完整。`);
  for (const frame of clip.frames) {
    const values = ['x', 'y', 'width', 'height', 'anchorX', 'anchorY'].map(key => frame[key]);
    if (values.some(value => !Number.isFinite(value)) || frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0 || frame.x + frame.width > image.width || frame.y + frame.height > image.height || frame.anchorX < 0 || frame.anchorX > frame.width || frame.anchorY < 0 || frame.anchorY > frame.height) throw new Error(`机器狗${name}动作图集边界无效。`);
  }
  if (clip.sequence && (!clip.sequence.length || clip.sequence.some(index => !Number.isInteger(index) || index < 0 || index >= clip.frames.length))) throw new Error(`机器狗${name}动作播放顺序无效。`);
}

/** 借鉴图集播放器的预解码机制：播放时不再请求、切换img.src或等待解码。
 * 参考：https://github.com/pixijs/pixijs/blob/dev/src/scene/sprite-animated/AnimatedSprite.ts
 */
export async function loadDogSprites(signal, { only = Object.keys(SPRITE_DURATIONS) } = {}) {
  const response = await fetch(SPRITE_MANIFEST, { signal });
  if (!response.ok) throw new Error('机器狗动作配置加载失败，请重试。');
  const manifest = await response.json();
  const entries = only.map(name => [name, manifest.actions?.[name]]);
  if (entries.some(([, clip]) => !clip?.src)) throw new Error('机器狗动作素材不完整，请重试。');
  const images = {};
  const results = await Promise.allSettled(entries.map(async ([name, clip]) => {
    const result = await fetch(clip.src, { signal });
    if (!result.ok) throw new Error(`机器狗${name}动作加载失败，请重试。`);
    const image = await createImageBitmap(await result.blob());
    images[name] = image;
    validateClip(name, clip, image);
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (signal.aborted || failed) {
    Object.values(images).forEach(image => image.close());
    throw signal.aborted ? new DOMException('动画加载已取消', 'AbortError') : failed.reason;
  }
  let released = false;
  return { manifest, images, release() { if (!released) Object.values(images).forEach(image => image.close()); released = true; } };
}
