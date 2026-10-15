import React, { Profiler } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ instances: [], frames: new Map(), next: 0, load: vi.fn(), failRenderer: false }));
vi.mock('../src/dogFrameAtlas.js', () => ({ loadCoherentDogSprites: (...args) => mock.load(...args) }));
vi.mock('../src/dogSpritePlayer.js', async importOriginal => ({ ...await importOriginal(), DogSpriteRenderer: class {
  constructor() { if (mock.failRenderer) throw new Error('绘图初始化失败'); this.stats = { frames: 0, sourceFrames: 0, blankFrames: 0, resizes: 1 }; this.draw = vi.fn(() => { this.stats.frames++; this.stats.sourceFrames++; return true; }); this.dispose = vi.fn(); this.resume = vi.fn(); mock.instances.push(this); }
} }));
import { RobotDog, RobotDogAvatar } from '../src/RobotDog.jsx';
import { SPRITE_DURATIONS } from '../src/dogSpriteAssets.js';
let time, assets;
beforeEach(() => {
  mock.instances.length = 0; mock.frames.clear(); mock.next = 0; mock.failRenderer = false; time = 0;
  assets = { release: vi.fn(), images: {}, manifest: { actions: {} } };
  for (const [name, duration_ms] of Object.entries(SPRITE_DURATIONS)) {
    assets.images[name] = { name };
    assets.manifest.actions[name] = { duration_ms, referenceHeight: 280, referenceWidth: 250, frames: Array.from({ length: 16 }, (_, x) => ({ x, y: 0, width: 240, height: 290, anchorX: 110, anchorY: 284 })) };
  }
  mock.load.mockReset().mockResolvedValue(assets);
  vi.spyOn(performance, 'now').mockImplementation(() => time); vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { mock.frames.set(++mock.next, callback); return mock.next; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn(id => mock.frames.delete(id)));
});
async function load() { await act(async () => { await Promise.resolve(); }); }
function frame(nextTime) { time = nextTime; const callback = [...mock.frames.values()].at(-1); mock.frames.clear(); act(() => callback(time)); }
function advanceTo(end) { while (time < end) frame(Math.min(end, time + 16)); }
it('一次预加载，安静时保持中立帧，画布身份稳定且不逐帧刷新React', async () => {
  let commits = 0; const view = render(<Profiler id="dog" onRender={() => commits++}><RobotDog /></Profiler>); await load(); frame(0);
  const canvas = screen.getByRole('img'), baseline = commits, renderer = mock.instances[0]; advanceTo(1200);
  expect(commits).toBe(baseline); expect(screen.getByRole('img')).toBe(canvas); expect(mock.load).toHaveBeenCalledOnce();
  const indices = new Set(renderer.draw.mock.calls.map(([sample]) => sample.index)); expect(indices.size).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: '眨眨眼' })); frame(1216); advanceTo(1950);
  const active = renderer.draw.mock.calls.filter(([sample]) => sample.name === 'blink');
  expect(new Set(active.map(([sample]) => sample.index)).size).toBeGreaterThan(5);
  expect(document.querySelector('.robot-dog-stage').dataset.renderer).toBe('spritesheet');
  view.unmount(); expect(renderer.dispose).toHaveBeenCalledOnce(); expect(assets.release).toHaveBeenCalledOnce(); expect(mock.frames.size).toBe(0);
});
it('语言顺序、三主动按钮和无人操作均播放动作帧', async () => {
  render(<RobotDog actions={[{ name: 'wave', trigger: 'explicit' }, { name: 'blink', trigger: 'explicit' }]} />); await load(); frame(0);
  expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('wave'); advanceTo(1600);
  expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('blink'); advanceTo(2400);
  fireEvent.click(screen.getByRole('button', { name: '摇尾巴' })); frame(2416); expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('wag_tail');
  advanceTo(3632); fireEvent.click(screen.getByRole('button', { name: '摸摸头' })); frame(3648); expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('happy');
  advanceTo(5264); fireEvent.click(screen.getByRole('button', { name: '眨眨眼' })); frame(5280); expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('blink');
  advanceTo(8100); expect(document.querySelector('.robot-dog-stage').dataset.trigger).toBe('idle');
});
it('暂停保留最后帧，恢复清旧队列并衔接原画面，不重载图集', async () => {
  const actions = [{ name: 'sleep', trigger: 'explicit' }]; const view = render(<RobotDog actions={actions} />); await load(); frame(0); advanceTo(1200);
  const canvas = screen.getByRole('img'), renderer = mock.instances[0], before = renderer.draw.mock.calls.length;
  view.rerender(<RobotDog actions={actions} reducedMotion />); frame(22000); expect(renderer.draw.mock.calls).toHaveLength(before);
  expect(screen.getByRole('button', { name: '摇尾巴' })).toBeDisabled(); view.rerender(<RobotDog actions={actions} />); frame(22016);
  expect(renderer.resume).toHaveBeenCalledOnce(); expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('idle');
  expect(screen.getByRole('img')).toBe(canvas); expect(mock.load).toHaveBeenCalledOnce(); expect(mock.instances).toHaveLength(1);
});
it('预览冻结首帧，恢复不追赶真实时间、不重放预览指令', async () => {
  const actions = [{ name: 'wave', trigger: 'explicit' }], view = render(<RobotDog actions={actions} preview />); await load(); frame(22000);
  expect(mock.instances[0].draw).toHaveBeenCalledTimes(1); view.rerender(<RobotDog actions={actions} />); frame(22016);
  expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('idle'); expect(mock.instances[0].draw.mock.calls.at(-1)[0].index).toBe(0);
});
it('加载失败中文重试，旧请求中止，晚到素材卸载后释放', async () => {
  mock.load.mockRejectedValueOnce(new Error('图集加载失败')); const view = render(<RobotDog />); await load();
  expect(screen.getByRole('alert')).toHaveTextContent('图集加载失败'); const signal = mock.load.mock.calls[0][0];
  fireEvent.click(screen.getByRole('button', { name: '重试动画' })); await load(); expect(signal.aborted).toBe(true); expect(mock.load).toHaveBeenCalledTimes(2);
  view.unmount(); expect(assets.release).toHaveBeenCalledOnce();
  let deliver; const late = { ...assets, release: vi.fn() }; mock.load.mockReturnValue(new Promise(resolve => { deliver = resolve; }));
  const waiting = render(<RobotDog />); waiting.unmount(); await act(async () => { deliver(late); }); expect(late.release).toHaveBeenCalledOnce();
});
it('渲染初始化异常释放素材并给中文重试提示', async () => {
  mock.failRenderer = true; render(<RobotDog />); await load();
  expect(screen.getByRole('alert')).toHaveTextContent('绘图初始化失败'); expect(assets.release).toHaveBeenCalledOnce();
});
it('加载超时中止请求而不是显示半套图集', async () => {
  vi.useFakeTimers(); mock.load.mockReturnValue(new Promise(() => {})); render(<RobotDog />);
  const signal = mock.load.mock.calls[0][0]; await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(signal.aborted).toBe(true); expect(screen.getByRole('alert')).toHaveTextContent('动作加载超时'); vi.useRealTimers();
});
it('正常取消不显示错误提示', async () => {
  mock.load.mockRejectedValueOnce(new DOMException('取消', 'AbortError')); render(<RobotDog />); await load(); expect(screen.queryByRole('alert')).toBeNull();
});
it('头像继续使用用户原稿，主角色没有调用旧网格播放器', () => {
  render(<RobotDogAvatar />); expect(screen.getByRole('img', { name: '小忆' }).querySelector('img')).toHaveAttribute('src', '/assets/robot-dog-reference.png');
});
it('抚摸角色驱动开心动作，未变化的画面不虚增帧数，卸载后迟到回调无副作用', async () => {
  const view = render(<RobotDog />); await load(); frame(0);
  fireEvent.click(screen.getByRole('button', { name: '摸摸小忆' })); frame(16);
  expect(document.querySelector('.robot-dog-stage').dataset.action).toBe('happy');
  const stage = document.querySelector('.robot-dog-stage'), before = stage.dataset.renderFrame;
  mock.instances[0].draw.mockReturnValue(false); frame(32);
  expect(stage.dataset.renderFrame).toBe(before);
  const callback = [...mock.frames.values()].at(-1), count = mock.instances[0].draw.mock.calls.length;
  view.unmount(); act(() => callback(48));
  expect(mock.instances[0].draw).toHaveBeenCalledTimes(count);
  expect(mock.frames.size).toBe(0);
});
it('改名同步头像与动作无障碍文案，不重新创建画布或加载动作素材', async () => {
  const view = render(<><RobotDog name="羊狗" /><RobotDogAvatar name="羊狗" /></>); await load();
  const canvas = screen.getByRole('img', { name: /机器狗羊狗/ });
  expect(screen.getByRole('img', { name: '羊狗' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '摸摸羊狗' })).toHaveAttribute('title', '点击摸摸羊狗');
  view.rerender(<><RobotDog name="团团" /><RobotDogAvatar name="团团" /></>);
  expect(screen.getByRole('img', { name: /机器狗团团/ })).toBe(canvas);
  expect(screen.getByRole('img', { name: '团团' })).toBeInTheDocument();
  expect(mock.load).toHaveBeenCalledOnce(); expect(mock.instances).toHaveLength(1);
});
