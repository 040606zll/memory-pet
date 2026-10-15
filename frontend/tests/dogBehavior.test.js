import { expect, it } from 'vitest';
import { DogBehavior } from '../src/dogBehavior.js';
import { SPRITE_DURATIONS } from '../src/dogSpriteAssets.js';

it('无人操作留出5.5秒以上安静期，三次眨眼后才偶尔摇尾，不随机点头或伸展', () => {
  const dog = new DogBehavior({ now: () => 0, random: () => 0, durations: SPRITE_DURATIONS });
  const events = []; let previous = null;
  for (let time = 0; time < 45000; time += 10) {
    const state = dog.tick(time);
    if (state.started != null && previous !== state.started) { events.push([state.name, state.started]); previous = state.started; }
  }
  expect(events.slice(0, 4).map(([name]) => name)).toEqual(['blink', 'blink', 'blink', 'wag_tail']);
  expect(events[0][1]).toBe(5500);
  for (let i = 1; i < events.length; i++) expect(events[i][1] - events[i-1][1]).toBeGreaterThanOrEqual(7300);
});
it('主动指令仍可打断自主小动作，最后一个动作结束后重新开始停顿', () => {
  const dog = new DogBehavior({ now: () => 0, random: () => 0, durations: SPRITE_DURATIONS });
  dog.tick(5500); dog.enqueue([{ name: 'wave', trigger: 'explicit' }, { name: 'nod', trigger: 'explicit' }]);
  expect(dog.tick(5600).name).toBe('wave'); expect(dog.tick(7200).name).toBe('nod');
  expect(dog.tick(8800).name).toBe('idle'); expect(dog.tick(15299).name).toBe('idle'); expect(dog.tick(15300).name).toBe('blink');
});
it('暂停期间不积压自主活动，恢复有完整停顿', () => {
  let time = 0; const dog = new DogBehavior({ now: () => time, random: () => .5 });
  dog.tick(8000); dog.setEnabled(false); time = 60000;
  expect(dog.tick(time)).toMatchObject({ name: 'idle', progress: 0 }); dog.setEnabled(true);
  expect(dog.tick(time + 7000).name).toBe('idle'); expect(dog.tick(time + 7250).name).toBe('blink');
});
