import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@rive-app/webgl2', () => import('./riveMock.js'));
import { Panda, PandaAvatar } from '../src/Panda.jsx';
import { bindPetControl, RIVE_PET } from '../src/rivePet.js';
import { instances, RuntimeLoader } from './riveMock.js';
beforeEach(() => { instances.length = 0; });

it('加载同源 Rive 状态机与 WASM，尺寸变化交给运行时', async () => {
  await act(async () => { render(<Panda />); });
  const instance = instances[0];
  expect(instance.options).toMatchObject({ src: '/assets/panda.riv', artboard: 'Panda', stateMachine: 'Panda', autoBind: true, enableRiveAssetCDN: false });
  expect(RuntimeLoader.wasmUrl).toContain('rive.wasm');
  expect(RuntimeLoader.fallbackUrl).toBeNull();
  expect(document.querySelector('.panda-stage')).toHaveAttribute('data-renderer', 'rive');
  expect(instance.resizeDrawingSurfaceToCanvas).toHaveBeenCalledTimes(1);
  fireEvent(window, new Event('resize'));
  expect(instance.resizeDrawingSurfaceToCanvas).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('小忆正在准备见你…')).not.toBeInTheDocument();
});

it('用户动作、无人操作和抚摸都驱动真实数据绑定契约', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  await act(async () => { render(<Panda actions={[{ name: 'wave', trigger: 'explicit', duration_ms: 1000 }]} />); });
  const instance = instances[0];
  act(() => instance.advance());
  expect(instance.action.value).toBe(RIVE_PET.actions.wave);
  expect(screen.getByText('向你挥手')).toBeInTheDocument();
  time = 1980; act(() => instance.advance());
  expect(instance.action.value).toBe(0);
  time = 5480; act(() => instance.advance());
  expect(instance.action.value).toBe(RIVE_PET.actions.blink);
  fireEvent.click(screen.getByRole('button', { name: '摸摸小忆' }));
  act(() => instance.advance());
  expect(instance.action.value).toBe(RIVE_PET.actions.happy);
});

it('暂停与恢复控制 Rive 本身，卸载释放 GPU 和动画循环', async () => {
  let view;
  await act(async () => { view = render(<Panda />); });
  const instance = instances[0];
  view.rerender(<Panda reducedMotion />);
  expect(instance.pause).toHaveBeenCalled();
  expect(screen.getByText('安静陪着你')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '摸摸小忆' })).toBeDisabled();
  expect(document.querySelector('.panda-stage')).toHaveAttribute('data-render-fps', '0');
  view.rerender(<Panda />);
  expect(instance.play).toHaveBeenCalled();
  view.unmount(); expect(instance.cleanup).toHaveBeenCalledTimes(1);
});

it('预览也使用同一 Rive 画板，并冻结在初始姿态', async () => {
  await act(async () => { render(<Panda preview />); });
  expect(instances[0].pause).toHaveBeenCalled();
  expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('Rive 熊猫'));
  expect(screen.getByRole('button', { name: '摸摸小忆' })).toBeDisabled();
});

it('加载失败显示中文重试，重试前清理旧实例', async () => {
  await act(async () => { render(<Panda />); });
  act(() => instances[0].options.onLoadError());
  expect(screen.getByRole('alert')).toHaveTextContent('熊猫动画加载失败');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试动画' })); });
  expect(instances).toHaveLength(2); expect(instances[0].cleanup).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('缺少正式绑定时明确失败，不伪造另一个动画实现', async () => {
  await act(async () => { render(<Panda />); });
  instances[0].viewModelInstance = null;
  act(() => instances[0].options.onLoad());
  expect(screen.getByRole('alert')).toHaveTextContent('动作绑定不完整');
  expect(() => bindPetControl({})).toThrow('动作绑定不完整');
});

it('每次同名动作只触发一次，新动作实例可重复触发', () => {
  const action = { value: 0 }, perform = { trigger: vi.fn() };
  const update = bindPetControl({ viewModelInstance: { number: () => action, trigger: () => perform } });
  update({ name: 'idle' }); expect(perform.trigger).not.toHaveBeenCalled();
  update({ name: 'wave', started: 100 }); update({ name: 'wave', started: 100 });
  expect(perform.trigger).toHaveBeenCalledTimes(1);
  update({ name: 'wave', started: 200 }); expect(perform.trigger).toHaveBeenCalledTimes(2);
  update({ name: 'unknown', started: 300 }); expect(action.value).toBe(0);
});

it('头像只用静态资源，宠物画板不播放图片帧', () => {
  render(<PandaAvatar />);
  expect(screen.getByRole('img', { name: '小忆' })).toHaveAttribute('src', '/assets/panda-rive-avatar.png');
});

it('连续语言动作按 Rive 成品时长交接，忽略旧图片帧时长', async () => {
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  await act(async () => { render(<Panda actions={[
    { name: 'blink', trigger: 'explicit', duration_ms: 8000 },
    { name: 'nod', trigger: 'explicit', duration_ms: 8000 },
  ]} />); });
  const instance = instances[0];
  act(() => instance.advance()); expect(instance.action.value).toBe(RIVE_PET.actions.blink);
  // 成品眨眼550ms，加180ms回待机过渡，之后应执行点头而非继续空等。
  time = 729; act(() => instance.advance()); expect(instance.action.value).toBe(RIVE_PET.actions.blink);
  time = 730; act(() => instance.advance()); expect(instance.action.value).toBe(RIVE_PET.actions.nod);
  time = 2160; act(() => instance.advance()); expect(instance.action.value).toBe(0);
});

it('暂停取消旧动作后，恢复会让 Rive 平滑回闲置而非续播旧动作', async () => {
  let time = 0, view;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const actions = [{ name: 'sleep', trigger: 'explicit', duration_ms: 5000 }];
  await act(async () => { view = render(<Panda actions={actions} />); });
  const instance = instances[0];
  act(() => instance.advance()); expect(instance.action.value).toBe(RIVE_PET.actions.sleep);
  time = 1000; view.rerender(<Panda actions={actions} reducedMotion />);
  const triggers = instance.perform.trigger.mock.calls.length;
  time = 20000; view.rerender(<Panda actions={actions} />);
  expect(instance.action.value).toBe(0);
  expect(instance.perform.trigger).toHaveBeenCalledTimes(triggers + 1);
  expect(screen.getByText('正在自己玩耍')).toBeInTheDocument();
  act(() => instance.advance());
  expect(instance.action.value).toBe(0);
});

import contract from '../public/assets/panda-rive-contract.json';
it('排队契约与实际交付的 Rive 时间线和返回混合一致', () => {
  for (const [name, action] of Object.entries(contract.actions)) {
    expect(RIVE_PET.actions[name]).toBe(action.value);
    expect(RIVE_PET.durations[name]).toBe(action.durationMs + (action.loop ? 0 : contract.returnBlendMs));
  }
});
