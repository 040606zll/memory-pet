import { describe, expect, it } from 'vitest';
import { DOG, DogMotion, deform, smooth } from '../src/dogMotion.js';
import { createDogMesh } from '../src/dogRenderer.js';
import { PetMachine } from '../src/petMachine.js';

const zero = { head: 0, headY: 0, body: 0, paw: 0, tail: 0, ear: 0, blink: 0 };
describe('机器狗原型纹理与连续姿态', () => {
  it('中性姿态完全保留原始顶点，所有三角形共用原图纹理坐标', () => {
    const mesh = createDogMesh();
    for (let i = 0; i < mesh.original.length; i += 2) expect(deform(mesh.original[i], mesh.original[i + 1], zero)).toEqual([mesh.original[i], mesh.original[i + 1]]);
    expect(mesh.positions).toEqual(mesh.original);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.original.length / 2);
  });
  it.each(Object.keys(DOG.durations))('%s动作连续推进且每种姿态都有真实变化', name => {
    const motion = new DogMotion(), duration = DOG.durations[name];
    let previous = null, changes = 0;
    for (let time = 0; time <= duration + 250; time += 16) {
      const state = time < duration ? { name, started: 0, progress: time / duration } : { name: 'idle' };
      const pose = motion.sample(state, time), point = deform(231, name === 'wave' ? 372 : 202, pose);
      expect(Object.values(pose).every(Number.isFinite)).toBe(true);
      expect(pose.blink).toBeGreaterThanOrEqual(0); expect(pose.blink).toBeLessThanOrEqual(1);
      if (previous) {
        expect(Math.hypot(point[0] - previous[0], point[1] - previous[1])).toBeLessThan(2);
        if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) > .001) changes++;
      }
      previous = point;
    }
    expect(changes).toBeGreaterThan(10);
  });
  it('显式指令打断动作时保持已显示姿态，随后插值进入新动作', () => {
    const motion = new DogMotion(); motion.sample({ name: 'sleep', started: 0, progress: 0 }, 0);
    const before = motion.sample({ name: 'sleep', started: 0, progress: .5 }, 2400);
    const changed = motion.sample({ name: 'happy', started: 2400, progress: 0 }, 2400);
    expect(changed).toEqual(before);
    const following = motion.sample({ name: 'happy', started: 2400, progress: .006 }, 2416);
    expect(Math.abs(following.blink - before.blink)).toBeLessThan(.02);
  });
  it('摇尾巴主要改变尾部位置，前爪脚底保持稳定', () => {
    const pose = { ...zero, tail: .5 };
    expect(Math.hypot(...deform(150, 245, pose).map((v, i) => v - [150, 245][i]))).toBeGreaterThan(5);
    expect(deform(211, 385, pose)).toEqual([211, 385]);
  });
  it('平滑函数钳制输入，队列采用机器狗真实动作时长且支持摇尾巴', () => {
    expect(smooth(-1)).toBe(0); expect(smooth(2)).toBe(1);
    const machine = new PetMachine({ now: () => 0, durations: DOG.durations });
    machine.enqueue([{ name: 'wag_tail', duration_ms: 9999, trigger: 'explicit' }, { name: 'blink', trigger: 'explicit' }]);
    expect(machine.tick(0)).toMatchObject({ name: 'wag_tail', duration_ms: 2200 });
    expect(machine.tick(2200).name).toBe('blink');
  });
});
