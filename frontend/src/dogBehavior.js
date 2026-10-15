import { PetMachine } from './petMachine.js';

/** 机器狗专用的安静陪伴节奏，保留共享队列的优先级，不改变其他角色的行为。 */
export class DogBehavior extends PetMachine {
  constructor(options = {}) {
    super(options);
    this.nextIdle = Infinity;
    this.idleDue = this.now() + 5500 + this.random() * 3500;
    this.spontaneous = 0;
  }
  tick(time = this.now()) {
    // 禁用父类的随机全身大动作，只在结束后的停顿期安排小动作。
    this.nextIdle = Infinity;
    const previous = this.current;
    let state = super.tick(time);
    if (previous && !this.current) this.idleDue = time + 6500 + this.random() * 4500;
    if (this.enabled && !this.current && time >= this.idleDue) {
      const name = ++this.spontaneous % 4 === 0 ? 'wag_tail' : 'blink';
      super.enqueue([{ name, trigger: 'idle' }]);
      state = super.tick(time);
    }
    return state;
  }
  setEnabled(enabled) {
    if (enabled && !this.enabled) this.idleDue = this.now() + 5500 + this.random() * 3500;
    super.setEnabled(enabled);
    this.nextIdle = Infinity;
  }
}
