const PRIORITY = { idle: 0, emotion: 1, explicit: 2 };
export const ACTION_LABELS = {
  idle: '正在自己玩耍', blink: '眨眨眼', wave: '向你挥手', nod: '点点头', shake_head: '摇摇头',
  stretch: '正在伸懒腰', happy: '开心地笑', sleep: '打个小盹', wag_tail: '开心地摇尾巴',
};
/** 动作按优先级排队。用户动作可打断闲置；回复动作不会覆盖正在执行的用户动作。 */
export class PetMachine {
  constructor({ random = Math.random, now = () => performance.now(), durations = {} } = {}) {
    this.random = random; this.now = now; this.queue = []; this.current = null;
    this.durations = durations;
    this.sequence = 0; this.nextIdle = now() + 3500; this.enabled = true;
  }
  enqueue(actions = []) {
    for (const action of actions) {
      if (!ACTION_LABELS[action.name]) continue;
      this.queue.push({ ...action, trigger: action.trigger || 'emotion', duration_ms: this.durations[action.name] ?? Math.max(800, Math.min(8000, action.duration_ms || 2400)), order: this.sequence++ });
    }
    this.queue.sort((a, b) => (PRIORITY[b.trigger] || 0) - (PRIORITY[a.trigger] || 0) || a.order - b.order);
    if (this.current && this.queue.length && (PRIORITY[this.queue[0].trigger] || 0) > (PRIORITY[this.current.trigger] || 0)) this.current = null;
    // 限制积压，避免聊天很快时动作一直排到数分钟之后。
    this.queue = this.queue.slice(0, 12);
  }
  tick(time = this.now()) {
    if (!this.enabled) return { name: 'idle', trigger: 'idle', progress: 0 };
    if (this.current && time >= this.current.started + this.current.duration_ms) {
      this.current = null; this.nextIdle = time + 2000 + this.random() * 4500;
    }
    if (!this.current && this.queue.length) this.current = { ...this.queue.shift(), started: time };
    if (!this.current && time >= this.nextIdle) {
      const idleActions = ['blink', 'idle', 'nod', 'stretch', 'idle'];
      const name = idleActions[Math.min(idleActions.length - 1, Math.floor(this.random() * idleActions.length))];
      this.current = { name, trigger: 'idle', duration_ms: this.durations[name] ?? (name === 'stretch' ? 3500 : 2100), started: time };
    }
    return this.current ? { ...this.current, progress: Math.min(1, Math.max(0, (time - this.current.started) / this.current.duration_ms)) } : { name: 'idle', trigger: 'idle', progress: 0 };
  }
  setEnabled(enabled) {
    // 恢复后先平静陪伴，再开始自主动作，避免长时间暂停后的瞬间跳转。
    if (enabled && !this.enabled) this.nextIdle = this.now() + 3500;
    this.enabled = enabled;
    if (!enabled) { this.queue = []; this.current = null; }
  }
}
