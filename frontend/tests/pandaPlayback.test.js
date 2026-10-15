import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPandaPainter, drawBlend, poseAt, poseGeometry, sampleMotion } from '../src/pandaPlayback.js';
const manifest = JSON.parse(readFileSync('public/assets/panda-animation.json', 'utf8'));
const assets = { manifest, sheets: Object.fromEntries(manifest.sheets.map(sheet => [sheet.id, { url: sheet.url }])) };
const state = (name, progress) => ({ name, progress, started: 0, duration_ms: 1800 });

describe('真实高清动作的连续播放', () => {
  it.each(Object.keys(manifest.actions))('%s 全程有中间姿态，首尾与同一闲置图连续衔接', name => {
    const start = sampleMotion(assets, state(name, 0));
    const end = sampleMotion(assets, state(name, 1));
    expect(start.from.key).toBe(poseAt(assets, 'idle').key);
    expect(start.mix).toBe(0);
    expect(end.to.key).toBe(start.from.key);
    expect(end.mix).toBeCloseTo(1);
    for (let progress = 0.1; progress < 1; progress += 0.02) {
      const sampled = sampleMotion(assets, state(name, progress));
      expect(sampled.from.frame).toBeDefined();
      expect(sampled.to.frame).toBeDefined();
      expect(sampled.mix).toBeGreaterThanOrEqual(0);
      expect(sampled.mix).toBeLessThanOrEqual(1);
    }
    const late = [0.6, 0.65, 0.7, 0.75, 0.8].map(progress => sampleMotion(assets, state(name, progress)));
    expect(new Set(late.map(({ from, to, mix }) => `${from.key}:${to.key}:${mix}`)).size).toBeGreaterThan(3);
  });
  it('无动作时保留同一张闲置图，不切换为另一张静态熊猫', () => {
    const result = sampleMotion(assets, { name: 'idle', progress: 0 });
    expect(result.from.key).toBe(result.to.key);
    expect(result.mix).toBe(0);
  });
  it('兼容单帧动作和不支持的名称，不访问负数帧索引', () => {
    const tiny = { manifest: { actions: { idle: { sheet: 's', frames: [manifest.actions.idle.frames[0]], sequence: [0] } } }, sheets: { s: {} } };
    const result = sampleMotion(tiny, state('missing', 0.5));
    expect(result.from.frame).toBe(result.to.frame);
    expect(result.mix).toBe(0);
  });
  it('所有素材的脚底锚点落在同一地面，无论每帧尺寸是否一致', () => {
    for (const name of Object.keys(manifest.actions)) {
      for (let index = 0; index < manifest.actions[name].frames.length; index++) {
        const pose = poseAt(assets, name, index), rect = poseGeometry(pose, 640, 640);
        expect(rect.y + pose.frame.anchorY * 640 / pose.referenceSize).toBeCloseTo(632);
      }
    }
  });
  it('两帧以预乘透明度加权，绘制完恢复默认状态', () => {
    const alphas = [], ctx = { clearRect: vi.fn(), drawImage() { alphas.push(this.globalAlpha); } };
    drawBlend(ctx, sampleMotion(assets, state('wave', 0.25)), 640, 640);
    expect(alphas).toHaveLength(2);
    expect(alphas[0] + alphas[1]).toBeCloseTo(1);
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
  it('打断动作时先保留屏幕姿态，再在160毫秒内交接到新姿态', () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 640;
    const draws = [], context = { clearRect: vi.fn(), drawImage(...args) { draws.push({ args, alpha: this.globalAlpha }); } };
    const snapshotContext = { clearRect: vi.fn(), drawImage: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(snapshotContext);
    const paint = createPandaPainter(canvas, context);
    paint(sampleMotion(assets, { name: 'idle' }), { name: 'idle' }, 0);
    paint(sampleMotion(assets, state('wave', 0.5)), state('wave', 0.5), 900);
    draws.length = 0;
    paint(sampleMotion(assets, state('blink', 0)), state('blink', 0), 916);
    expect(snapshotContext.drawImage).toHaveBeenLastCalledWith(canvas, 0, 0);
    expect(draws.at(-1).alpha).toBe(1);
    paint(sampleMotion(assets, state('blink', 0.05)), state('blink', 0.05), 996);
    expect(draws.at(-1).alpha).toBeCloseTo(0.5);
    draws.length = 0;
    paint(sampleMotion(assets, state('blink', 0.1)), state('blink', 0.1), 1076);
    expect(draws.every(draw => draw.args.length === 9)).toBe(true);
    expect(snapshotContext.drawImage).toHaveBeenCalledTimes(2);
  });
  it('缓冲画布不可用时仍能播放，不留下零透明度的熊猫', () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 640;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const context = { clearRect() {}, drawImage: vi.fn() }, paint = createPandaPainter(canvas, context);
    paint(sampleMotion(assets, state('wave', 0.5)), state('wave', 0.5), 0);
    paint(sampleMotion(assets, state('blink', 0.5)), state('blink', 0.5), 16);
    expect(context.drawImage).toHaveBeenCalled();
    expect(context.globalAlpha).toBe(1);
  });
});
