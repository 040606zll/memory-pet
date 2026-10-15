import { expect, it } from 'vitest';
import manifest from '../public/assets/robot-dog-sprites-v1/manifest.json';
import { spriteFrame } from '../src/dogSpritePlayer.js';
import { DogBehavior } from '../src/dogBehavior.js';

// 用真实图集配置采样安静状态，不能以没有空白帧代替连续性检查。
const assets = { manifest, images: Object.fromEntries(Object.keys(manifest.actions).map(name => [name, { name }])) };
it('没有动作时保持同一中立姿态，不以全身图集快速循环冒充呼吸', () => {
  const keys = new Set(Array.from({ length: 200 }, (_, index) => spriteFrame(assets, { name: 'idle', trigger: 'idle', progress: 0 }, index * 16).key));
  expect(keys.size).toBe(1);
});
it('安静陪伴的大动作不会在短间隔自动反复触发', () => {
  const machine = new DogBehavior({ random: () => .7, now: () => 0 });
  const events = []; let previous = '';
  for (let time = 0; time <= 30000; time += 50) {
    const state = machine.tick(time), key = `${state.name}:${state.started}`;
    if (state.started != null && previous !== key) events.push(state.name);
    previous = key;
  }
  expect(events.filter(name => ['nod', 'stretch', 'shake_head', 'happy'].includes(name))).toEqual([]);
});
it('所有动作使用同一中立参考，播放器不再添加第二张透明姿态', () => {
  const rest = spriteFrame(assets, { name: 'idle' }, 0);
  for (const name of Object.keys(manifest.actions)) {
    const start = spriteFrame(assets, { name, started: 0, progress: 0 }, 0), end = spriteFrame(assets, { name, started: 0, progress: 1 }, 1000);
    expect(start.neutral.image).toBe(rest.neutral.image); expect(end.neutral.frame).toBe(rest.neutral.frame);
    expect(start.activeWeight).toBeUndefined(); expect(end.frameMix).toBeUndefined();
  }
});
it('帧内保持同一张源图，不用透明中间帧制造双脸重影', () => {
  const a = spriteFrame(assets, { name: 'blink', started: 0, progress: .32 }, 256), b = spriteFrame(assets, { name: 'blink', started: 0, progress: .325 }, 260);
  expect(a.key).toBe(b.key); expect(a.paintKey).toBe(b.paintKey);
  expect(a.nextFrame).toBeUndefined(); expect(a.frameMix).toBeUndefined(); expect(a.region).toBeUndefined();
});
