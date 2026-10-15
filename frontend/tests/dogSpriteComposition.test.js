import { beforeEach, expect, it, vi } from 'vitest';
import { DogFramePainter, motionWeight, poseGeometry, MOTION_REGIONS } from '../src/dogSpriteComposition.js';
let contexts, target;
function context() { return { clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })) }; }
const frame = { x: 0, y: 0, width: 272, height: 288, anchorX: 117.5, anchorY: 285 };
const neutral = { image: { type: 'neutral' }, frame, referenceHeight: 285, referenceWidth: 272 };
const sample = { ...neutral, name: 'blink', image: { type: 'action' }, neutral, region: MOTION_REGIONS.blink, activeWeight: 1, nextFrame: { ...frame, x: 320 }, frameMix: .25 };
beforeEach(() => {
  contexts = []; target = context();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { const ctx = context(); contexts.push(ctx); return ctx; });
});
it('起手和收势为同一中立图，运动中段才完整显示动作', () => {
  expect(motionWeight(0)).toBe(0); expect(motionWeight(1)).toBe(0); expect(motionWeight(.5)).toBe(1);
  expect(motionWeight(.08)).toBeCloseTo(.5);
});
it('同一等比比例及固定脚底，不随生成帧高变动把整个动物拉长压扁', () => {
  const target = poseGeometry(sample, 320, 350); const moved = poseGeometry({ ...sample, frame: { ...frame, height: 270, anchorY: 267 } }, 320, 350);
  expect(target.scale).toBe(moved.scale); expect(target.width/frame.width).toBe(target.height/frame.height);
  expect(moved.y + 267 * moved.scale).toBe(350);
});
it('静止状态只绘制中立图，不启动局部替换', () => {
  const painter = new DogFramePainter(); painter.paint(target, { ...sample, name: 'idle' }, 320, 350);
  expect(target.drawImage).toHaveBeenCalledOnce(); expect(target.drawImage.mock.calls[0][0]).toBe(neutral.image);
  expect(contexts[0].drawImage).not.toHaveBeenCalled();
  painter.paint(target, { ...sample, activeWeight: 0 }, 320, 350); expect(contexts[0].drawImage).not.toHaveBeenCalled();
});
it('两张真正源图片帧局部混合，固定区域仍使用中立图', () => {
  const painter = new DogFramePainter(); painter.paint(target, sample, 320, 350);
  expect(contexts[0].drawImage.mock.calls[0][0]).toBe(sample.image); expect(contexts[0].drawImage.mock.calls[1].slice(1,5)).toEqual([320,0,272,288]);
  expect(contexts[1].createRadialGradient).toHaveBeenCalledOnce(); expect(target.drawImage.mock.calls[0][0]).toBe(neutral.image);
  expect(target.drawImage.mock.calls.at(-1)[0]).toBe(painter.pose);
  painter.paint(target, { ...sample, frameMix: 0, region: MOTION_REGIONS.wag_tail }, 320, 350);
  expect(contexts[1].clearRect).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number));
  expect(painter.pose.width).toBe(320); painter.dispose(); expect(painter.pose.width).toBe(0);
});
it('完整身体动作仍播放完整真实帧；缺省配置和不可用画布有兜底', () => {
  const painter = new DogFramePainter(); painter.paint(target, { ...neutral, name: 'stretch' }, 160, 175);
  expect(contexts[1].fillRect).toHaveBeenCalledWith(0,0,160,175);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  expect(() => new DogFramePainter()).toThrow('无法合成宠物动作');
});
