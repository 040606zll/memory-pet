import { describe, expect, it, vi } from 'vitest';
import { normalizeCommand, normalizeCommands, interactionEvent } from '../src/pet3d/protocol.js';
import { PetBrain, DEFAULT_STATS } from '../src/pet3d/petBrain.js';
import { MockPetTransport, PetDriver } from '../src/pet3d/petDriver.js';

describe('3D 宠物驱动协议', () => {
  it('兼容聊天接口的旧动作格式', () => {
    expect(normalizeCommand({ name: 'wave', trigger: 'explicit', duration_ms: 2400 })).toMatchObject({ type: 'action', name: 'wave', trigger: 'explicit', duration_ms: 2400 });
    expect(normalizeCommand({ name: 'happy' })).toMatchObject({ type: 'action', trigger: 'emotion' });
  });
  it('拒绝未知动作、内部动作和非法字段', () => {
    expect(normalizeCommand({ type: 'action', name: 'fly' })).toBeNull();
    expect(normalizeCommand({ type: 'action', name: 'walk' })).toBeNull();
    expect(normalizeCommand({ type: 'emotion', name: 'furious' })).toBeNull();
    expect(normalizeCommand({ type: 'say', text: '   ' })).toBeNull();
    expect(normalizeCommand(null)).toBeNull();
  });
  it('服务端要求捡球时转换为生成球', () => {
    expect(normalizeCommand({ type: 'action', name: 'fetch' })).toEqual({ type: 'spawn', item: 'ball' });
  });
  it('规范化状态值和批量指令', () => {
    expect(normalizeCommand({ type: 'stats', hunger: 140, mood: -5, bogus: 1 })).toEqual({ type: 'stats', hunger: 100, mood: 0 });
    expect(normalizeCommands({ commands: [{ type: 'say', text: '你好' }, { type: 'nope' }] })).toHaveLength(1);
    expect(normalizeCommand({ type: 'action', name: 'sit', duration_ms: 999999 }).duration_ms).toBe(20000);
  });
  it('交互事件带时间戳', () => {
    expect(interactionEvent('feed', { item: 'bone' }, 0)).toEqual({ type: 'interaction', kind: 'feed', detail: { item: 'bone' }, at: '1970-01-01T00:00:00.000Z' });
  });
});

describe('PetBrain 行为大脑', () => {
  const brain = (options = {}) => { let time = 0; const b = new PetBrain({ now: () => time, random: () => 0, ...options }); b.advance = ms => { time += ms; return b.tick(time); }; return b; };

  it('用户动作打断自主动作，情绪动作不打断用户动作', () => {
    const b = brain();
    b.enqueue([{ name: 'sniff', trigger: 'idle' }]); b.advance(0);
    b.enqueue([{ name: 'sit', trigger: 'explicit' }]);
    expect(b.advance(10).action.name).toBe('sit');
    b.enqueue([{ name: 'happy', trigger: 'emotion' }]);
    expect(b.advance(10).action.name).toBe('sit');
  });
  it('动作期间使用对应姿态，结束后回到基础姿态', () => {
    const b = brain();
    b.enqueue([{ name: 'sit', trigger: 'explicit', duration_ms: 1000 }]);
    expect(b.advance(0).posture).toBe('sit');
    expect(b.advance(1500).posture).toBe('stand');
  });
  it('无时长动作需要显式结束，并清理同名排队', () => {
    const b = brain();
    b.enqueue([{ name: 'fetch', trigger: 'explicit' }, { name: 'walk', trigger: 'explicit' }]);
    expect(b.advance(100000).action.name).toBe('fetch');
    b.finish('walk'); b.finish('fetch');
    expect(b.queue).toHaveLength(0);
    expect(['fetch', 'walk']).not.toContain(b.advance(10).action?.name);
  });
  it('状态值按时间衰减并限制在 0~100', () => {
    const b = brain();
    b.decay(60 * 60000);
    expect(b.stats.hunger).toBeLessThan(DEFAULT_STATS.hunger);
    b.applyStats({ hunger: 500, mood: -500 });
    expect(b.stats).toMatchObject({ hunger: 100, mood: 0 });
  });
  it('精力低时自主入睡，睡觉时精力恢复', () => {
    const b = brain({ stats: { energy: 10 }, random: () => 0.9 });
    b.advance(20000);
    expect(b.basePosture).toBe('sleep');
    b.decay(60000);
    expect(b.stats.energy).toBeGreaterThan(10);
  });
  it('暂停时清空队列且不再产生动作', () => {
    const b = brain();
    b.enqueue([{ name: 'bark', trigger: 'explicit' }]);
    b.setEnabled(false);
    expect(b.advance(100000).action).toBeNull();
  });
});

describe('PetDriver 与本地 mock', () => {
  it('上报交互后把 mock 的反应分发给订阅者', async () => {
    const driver = new PetDriver(new MockPetTransport({ random: () => 0, storage: null }));
    const listener = vi.fn();
    driver.subscribe(listener);
    await driver.report('pet_head');
    expect(listener).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: 'emotion', name: 'love' }), expect.objectContaining({ type: 'say' })]));
  });
  it('吃饱时拒绝投喂', async () => {
    const transport = new MockPetTransport({ storage: null });
    const reply = await transport.sendEvent(interactionEvent('feed', { item: 'bone' }), { hunger: 99 });
    expect(reply[0]).toMatchObject({ type: 'action', name: 'shake_head' });
  });
  it('状态值保存在本地存储', async () => {
    const transport = new MockPetTransport({ storageKey: 'pet-test', storage: localStorage });
    await transport.saveState({ hunger: 42 });
    expect((await transport.loadState()).stats).toEqual({ hunger: 42 });
  });
  it('传输失败不影响页面', async () => {
    const driver = new PetDriver({ sendEvent: () => Promise.reject(new Error('offline')), loadState: () => Promise.reject(new Error('x')), saveState: () => Promise.reject(new Error('x')) });
    await expect(driver.report('poke')).resolves.toEqual([]);
    await expect(driver.loadState()).resolves.toBeNull();
  });
});
