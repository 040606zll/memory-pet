/** 资源与运行时约定；编号对应 Rive 源工程的 PandaControl.action。 */
export const RIVE_PET = {
  src: '/assets/panda.riv', artboard: 'Panda', stateMachine: 'Panda',
  actions: { idle: 0, blink: 1, wave: 2, nod: 3, shake_head: 4, stretch: 5, happy: 6, sleep: 7 },
  // 与成品契约一致：一次动作结束后还需完成180ms回闲置的混合。
  // 排队使用原生时间线，不受上游沿用的图片帧时长影响。
  durations: { idle: 4000, blink: 730, wave: 1980, nod: 1430, shake_head: 1680, stretch: 2980, happy: 2080, sleep: 4180 },
};

/** 使用正式数据绑定接口，避免调用已弃用的 stateMachineInputs。
 * 绑定不存在时明确失败，不能用另一种动画冒充 Rive 状态机。
 * https://rive.app/docs/runtimes/data-binding
 */
export function bindPetControl(instance) {
  const model = instance.viewModelInstance;
  const action = model?.number('action'), perform = model?.trigger('perform');
  if (!action || !perform) throw new Error('熊猫动画的动作绑定不完整，请重新加载。');
  let previous;
  return state => {
    const key = `${state.name}:${state.started ?? 'rest'}`;
    if (key === previous) return;
    previous = key;
    action.value = RIVE_PET.actions[state.name] ?? 0;
    // 闲置的呼吸由资源内部持续播放；同一种用户动作连续两次也要重新触发。
    if (state.started != null || state.name !== 'idle') perform.trigger();
  };
}
