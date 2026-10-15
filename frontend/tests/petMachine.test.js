import { describe, it, expect } from 'vitest';
import { PetMachine } from '../src/petMachine.js';

describe('宠物动作调度', () => {
  it('缺省动作和未知触发来源具有稳定的低优先级，伸展使用独立闲置时长', () => {
    const machine = new PetMachine({ now: () => 0, random: () => .7 });
    machine.enqueue(); machine.enqueue([{ name: 'wave' }]);
    expect(machine.tick(0)).toMatchObject({ trigger: 'emotion', duration_ms: 2400 });
    machine.enqueue([{ name: 'blink', trigger: 'unknown' }, { name: 'nod', trigger: 'idle' }]);
    expect(machine.tick(100).name).toBe('wave');
    expect(machine.queue.map(action => action.name)).toEqual(['blink', 'nod']);
    const unknown = new PetMachine({ now: () => 0 });
    unknown.enqueue([{ name: 'blink', trigger: 'unknown' }]); unknown.tick(0);
    unknown.enqueue([{ name: 'wave', trigger: 'explicit' }]);
    expect(unknown.tick(1).name).toBe('wave');
    const idle = new PetMachine({ now: () => 0, random: () => .7 });
    expect(idle.tick(3500)).toMatchObject({ name: 'stretch', duration_ms: 3500 });
  });
  it('无人操作时自行开始动作，完成后留出自然停顿', () => {
    const machine = new PetMachine({ random: () => 0, now: () => 0 });
    expect(machine.tick(0).name).toBe('idle');
    expect(machine.tick(3500)).toMatchObject({ name: 'blink', trigger: 'idle' });
    expect(machine.tick(4500).progress).toBeGreaterThan(0);
    expect(machine.tick(5600).name).toBe('idle');
    expect(machine.tick(7599).name).toBe('idle');
    expect(machine.tick(7600).name).toBe('blink');
  });
  it('显式动作立即打断闲置，情绪动作等待用户动作完成', () => {
    const machine = new PetMachine({ random: () => 0, now: () => 0 });
    machine.tick(3500);
    machine.enqueue([{ name: 'wave', trigger: 'explicit', duration_ms: 1000 }]);
    expect(machine.tick(3600)).toMatchObject({ name: 'wave', trigger: 'explicit' });
    machine.enqueue([{ name: 'happy', trigger: 'emotion' }]);
    expect(machine.tick(4000).name).toBe('wave');
    expect(machine.tick(4600).name).toBe('happy');
  });
  it('多个语言动作按原顺序执行且不被覆盖', () => {
    const machine = new PetMachine({ now: () => 0 });
    machine.enqueue([{ name: 'blink', trigger: 'explicit', duration_ms: 1000 }, { name: 'nod', trigger: 'explicit', duration_ms: 1000 }]);
    expect(machine.tick(0).name).toBe('blink');
    expect(machine.tick(1000).name).toBe('nod');
    expect(machine.tick(2000).name).toBe('idle');
  });
  it('忽略不支持动作，限制积压与持续时间', () => {
    const machine = new PetMachine({ now: () => 0 });
    machine.enqueue([{ name: 'ear' }, { name: 'unknown' }]);
    expect(machine.queue).toHaveLength(0);
    machine.enqueue(Array.from({ length: 100 }, () => ({ name: 'wave', trigger: 'explicit', duration_ms: 50000 })));
    expect(machine.queue).toHaveLength(12);
    expect(machine.tick(0).duration_ms).toBe(8000);
  });
  it('减少动态时静止且清除队列，恢复后继续自主活动', () => {
    const machine = new PetMachine({ random: () => 0, now: () => 0 });
    machine.enqueue([{ name: 'wave', trigger: 'explicit' }]);
    machine.setEnabled(false);
    expect(machine.tick(5000)).toMatchObject({ name: 'idle', progress: 0 });
    expect(machine.queue).toHaveLength(0);
    machine.setEnabled(true);
    expect(machine.tick(5001).name).toBe('blink');
  });
});
