import { poseGeometry } from './dogSpriteComposition.js';

/** 活动时钟：暂停或后台长间隔不追赶几秒钟的旧帧，避免恢复瞬间跳过动作。 */
export class SpriteClock {
  constructor() { this.time = 0; this.previous = null; }
  pause() { this.previous = null; }
  advance(wallTime) {
    if (this.previous != null) this.time += Math.max(0, Math.min(64, wallTime - this.previous));
    this.previous = wallTime;
    return this.time;
  }
}

/** 只选择预绘制的完整姿态帧，不拉伸局部像素、不计算骨骼或网格变形。 */
export function spriteFrame(assets, state, time) {
  const name = assets.manifest.actions[state.name] ? state.name : 'idle';
  const clip = assets.manifest.actions[name], sequence = clip.sequence || clip.frames.map((_, index) => index);
  const restClip = assets.manifest.actions.blink || assets.manifest.actions.idle;
  const neutral = { image: assets.images[assets.manifest.actions.blink ? 'blink' : 'idle'], frame: restClip.frames[0], referenceHeight: restClip.referenceHeight || restClip.frames[0].anchorY, referenceWidth: restClip.referenceWidth || restClip.frames[0].width };
  // 安静状态不循环全身图集；所有动作共用同一张中立姿态。
  const progress = state.started == null || name === 'idle' ? 0 : Math.max(0, Math.min(1, state.progress || 0));
  const position = progress * (sequence.length - 1), slot = Math.floor(position), index = sequence[slot];
  const sample = { image: assets.images[name], frame: clip.frames[index], frames: clip.frames, referenceHeight: clip.referenceHeight || clip.frames[0].anchorY, referenceWidth: clip.referenceWidth, index, name, neutral, key: `${name}:${index}`, actionKey: `${name}:${state.started ?? 'idle'}` };
  if (name === 'idle') { sample.image = neutral.image; sample.frame = neutral.frame; sample.key = 'idle:0'; sample.index = 0; }
  if (assets.manifest.format === 'coherent-rigid-frames') sample.key = `atlas:${sample.frame.x}:${sample.frame.y}`;
  // 同一时刻只显示一张已完成的图片帧。禁止两个不同位置的脸做透明交叉混合。
  sample.paintKey = sample.key;
  return sample;
}

/** 同一动作统一比例，按每帧脚底锚点定位；只是等比绘制完整图像，禁止形变。 */
export function spriteGeometry(sample, width, height) {
  return poseGeometry(sample, width, height);
}

/** 双缓冲提交完整画面：先在离屏画布完成裁切，再一次copy到常驻可见canvas。
 * 按时间采样的帧序列和锚点借鉴PixiJS/Phaser；没有复制其源码或增加依赖。
 */
export class DogSpriteRenderer {
  constructor(canvas, { diagnose = false } = {}) {
    // 像素诊断统一使用CPU读回，避免不同Canvas后端的半透明舍入差异干扰验收。
    this.canvas = canvas; this.context = canvas.getContext('2d', { willReadFrequently: diagnose });
    this.buffer = document.createElement('canvas'); this.bufferContext = this.buffer.getContext('2d', { willReadFrequently: diagnose });
    if (!this.context || !this.bufferContext) throw new Error('浏览器无法播放宠物动画，请重试。');
    this.buffer.width = canvas.width; this.buffer.height = canvas.height;
    this.diagnose = diagnose; this.key = null; this.paintKey = null; this.resumePending = false;
    this.stats = { frames: 0, sourceFrames: 0, blankFrames: 0, resizes: 0 };
  }
  resume() { this.resumePending = true; }
  draw(sample, time) {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    const resized = this.canvas.width !== width || this.canvas.height !== height;
    if (resized) {
      this.canvas.width = this.buffer.width = width;
      this.canvas.height = this.buffer.height = height;
      this.key = null; this.paintKey = null; this.stats.resizes++;
    }
    if (this.resumePending && this.lastSample?.name !== 'idle' && this.lastSample?.frames) {
      const previous = this.lastSample, last = previous.frames.length - 1;
      this.recovery = { sample: previous, started: time, direction: previous.index < last / 2 ? -1 : 1, last };
    }
    if (this.recovery && sample.name === 'idle') {
      // 恢复时沿已经烘焙的图片帧走向最近中立端点，禁止用透明淡化突然换脸。
      const recovery = this.recovery, index = recovery.sample.index + recovery.direction * Math.floor((time - recovery.started) * .03);
      if (index > 0 && index < recovery.last) sample = { ...recovery.sample, index, frame: recovery.sample.frames[index], key: `recover:${recovery.sample.actionKey}:${index}` };
      else this.recovery = null;
    } else if (sample.name !== 'idle') this.recovery = null;
    if (!resized && !this.resumePending && sample.key === this.paintKey) return false;
    this.resumePending = false;
    const ctx = this.bufferContext;
    ctx.clearRect(0, 0, width, height);
    const frame = sample.frame, target = spriteGeometry(sample, width, height);
    // 只等比裁切烘焙好的完整帧，不在播放器内处理局部遮罩、透明混合或图像形变。
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(sample.image, frame.x, frame.y, frame.width, frame.height, target.x, target.y, target.width, target.height);
    this.context.globalCompositeOperation = 'copy'; this.context.drawImage(this.buffer, 0, 0); this.context.globalCompositeOperation = 'source-over';
    if (sample.key !== this.key) this.stats.sourceFrames++;
    this.key = sample.key; this.paintKey = sample.key; this.lastSample = sample; this.stats.frames++;
    if (this.diagnose) {
      // 伸懒腰可能离开中心点；检查完整画布的实心像素，不将换姿势误判为空白。
      const pixels = this.context.getImageData(0, 0, width, height).data;
      let visible = false;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] >= 128) { visible = true; break; }
      if (!visible) this.stats.blankFrames++;
    }
    return true;
  }
  dispose() { this.buffer.width = 0; }
}
