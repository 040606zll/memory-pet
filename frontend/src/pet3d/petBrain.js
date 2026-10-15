import { PET_ACTIONS } from './protocol.js';

/** 用户点的动作 > 服务端主动指令 > 聊天情绪动作 > 自主动作。 */
const PRIORITY = { idle: 0, emotion: 1, server: 2, explicit: 3 };
const STAT_KEYS = ['hunger', 'mood', 'energy', 'affection'];
export const DEFAULT_STATS = { hunger: 70, mood: 75, energy: 80, affection: 20 };
// 每分钟变化量；演示节奏比真实宠物快，便于看到饥饿、困倦带来的行为变化。
const DECAY_PER_MINUTE = { hunger: -0.8, mood: -0.5, energy: -0.6 };
const SLEEP_RECOVERY_PER_MINUTE = 8;

const clamp = value => Math.max(0, Math.min(100, value));

/** 宠物的行为大脑：动作队列、姿态、情绪、状态值与自主行为，不涉及渲染。 */
export class PetBrain {
  constructor({ now = () => performance.now(), random = Math.random, stats = DEFAULT_STATS } = {}) {
    this.now = now; this.random = random;
    this.stats = { ...DEFAULT_STATS, ...stats };
    this.queue = []; this.current = null; this.sequence = 0;
    this.basePosture = 'stand';
    this.emotion = { name: 'neutral', intensity: 0, until: 0 };
    this.enabled = true;
    this.lastInteraction = now();
    this.nextAuto = now() + 6000 + random() * 4000;
  }

  enqueue(commands = []) {
    for (const command of commands) {
      const spec = PET_ACTIONS[command.name];
      if (!spec || command.name === 'idle') continue;
      const trigger = command.trigger || 'emotion';
      if (trigger !== 'idle' && this.basePosture === 'sleep' && command.name !== 'sleep') this.basePosture = 'stand';
      this.queue.push({ name: command.name, trigger, duration_ms: command.duration_ms || spec.duration, params: command.params || {}, order: this.sequence++ });
    }
    this.queue.sort((a, b) => PRIORITY[b.trigger] - PRIORITY[a.trigger] || a.order - b.order);
    // 更高优先级可立即打断当前动作，例如用户点击打断自主张望。
    if (this.current && this.queue.length && PRIORITY[this.queue[0].trigger] > PRIORITY[this.current.trigger]) this.current = null;
    this.queue = this.queue.slice(0, 10);
  }

  /** 用户直接交互：记录时间，唤醒宠物，交给调用方决定具体动作。 */
  touch() { this.lastInteraction = this.now(); }

  setEmotion(name, intensity = 0.7, duration = 6000) {
    this.emotion = { name, intensity, until: this.now() + duration };
  }

  setPosture(name) {
    this.basePosture = name;
    if (name === 'sleep') { this.queue = []; this.current = null; }
  }

  applyStats(delta = {}) {
    for (const key of STAT_KEYS) if (typeof delta[key] === 'number') this.stats[key] = clamp(this.stats[key] + delta[key]);
    return this.stats;
  }

  setStats(values = {}) {
    for (const key of STAT_KEYS) if (typeof values[key] === 'number') this.stats[key] = clamp(values[key]);
  }

  decay(elapsedMs) {
    const minutes = elapsedMs / 60000;
    const asleep = this.basePosture === 'sleep' || this.current?.name === 'sleep';
    this.stats.hunger = clamp(this.stats.hunger + DECAY_PER_MINUTE.hunger * minutes);
    this.stats.mood = clamp(this.stats.mood + DECAY_PER_MINUTE.mood * minutes * (this.stats.hunger < 25 ? 2 : 1));
    this.stats.energy = clamp(this.stats.energy + (asleep ? SLEEP_RECOVERY_PER_MINUTE : DECAY_PER_MINUTE.energy) * minutes);
  }

  /** 结束无固定时长的动作（如捡球），由场景控制器在完成时调用。 */
  finish(name) {
    if (this.current && (!name || this.current.name === name)) this.current = null;
    if (name) this.queue = this.queue.filter(item => item.name !== name);
  }

  setEnabled(enabled) {
    if (enabled && !this.enabled) this.nextAuto = this.now() + 4000;
    this.enabled = enabled;
    if (!enabled) { this.queue = []; this.current = null; }
  }

  tick(time = this.now()) {
    if (!this.enabled) return this.snapshot(null, time);
    const current = this.current;
    if (current && current.duration_ms > 0 && time >= current.started + current.duration_ms) {
      this.current = null;
      this.nextAuto = time + 5000 + this.random() * 6000;
    }
    if (!this.current && this.queue.length) this.current = { ...this.queue.shift(), started: time };
    if (!this.current && time >= this.nextAuto) {
      const choice = this.autonomous(time);
      this.nextAuto = time + 7000 + this.random() * 7000;
      if (choice === 'sleep') this.setPosture('sleep');
      else if (choice) this.current = { name: choice, trigger: 'idle', duration_ms: PET_ACTIONS[choice].duration, params: {}, started: time, order: this.sequence++ };
    }
    // 睡够了自己醒来。
    if (this.basePosture === 'sleep' && this.stats.energy >= 98 && !this.current) {
      this.basePosture = 'stand';
      this.current = { name: 'wake_up', trigger: 'idle', duration_ms: PET_ACTIONS.wake_up.duration, params: {}, started: time, order: this.sequence++ };
    }
    return this.snapshot(this.current, time);
  }

  /** 根据状态值挑选自主行为：困了睡觉、饿了讨食，心情好时更活泼。 */
  autonomous(time) {
    if (this.basePosture === 'sleep') return null;
    const idleFor = time - this.lastInteraction;
    if (this.stats.energy < 25 || (this.stats.energy < 50 && idleFor > 120000)) return this.random() < 0.5 ? 'yawn' : 'sleep';
    if (this.stats.hunger < 30) return this.random() < 0.5 ? 'bark' : 'sniff';
    const pool = this.stats.mood > 70
      ? ['wag_tail', 'look_around', 'blink', 'spin', 'sniff', 'wag_tail', 'scratch']
      : ['look_around', 'blink', 'sniff', 'sit', 'yawn', 'scratch'];
    return pool[Math.floor(this.random() * pool.length) % pool.length];
  }

  snapshot(current, time) {
    const emotion = time < this.emotion.until ? this.emotion : { name: this.moodEmotion(), intensity: 0.4 };
    const action = current ? {
      ...current,
      elapsed: time - current.started,
      progress: current.duration_ms > 0 ? Math.min(1, (time - current.started) / current.duration_ms) : 0,
    } : null;
    const posture = action && PET_ACTIONS[action.name].posture ? PET_ACTIONS[action.name].posture : this.basePosture;
    return { action, posture, emotion, stats: { ...this.stats } };
  }

  moodEmotion() {
    if (this.basePosture === 'sleep') return 'sleepy';
    if (this.stats.energy < 25) return 'sleepy';
    if (this.stats.hunger < 25 || this.stats.mood < 30) return 'sad';
    if (this.stats.mood > 80) return 'happy';
    return 'neutral';
  }
}
