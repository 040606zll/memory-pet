import { useEffect, useRef, useState } from 'react';
import { Alignment, Fit, Layout, Rive, RuntimeLoader } from '@rive-app/webgl2';
import wasmUrl from '@rive-app/webgl2/rive.wasm?url';
import { ACTION_LABELS, PetMachine } from './petMachine.js';
import { bindPetControl, RIVE_PET } from './rivePet.js';

// WASM 与 .riv 都由本项目提供，播放不依赖第三方 CDN 或图片图集。
RuntimeLoader.setWasmUrl(wasmUrl);
RuntimeLoader.setWasmFallbackUrl(null);

/** 唯一的动画循环由 Rive 运行时管理；页面只驱动状态机，不逐帧切换图片。 */
export function Panda({ actions = [], preview = false, mode = 'training', reducedMotion = false }) {
  const machine = useRef(new PetMachine({ durations: RIVE_PET.durations }));
  const canvas = useRef(null), stage = useRef(null), player = useRef(null), control = useRef(null);
  const previousActions = useRef(null), runtimePaused = useRef(false);
  const settings = useRef({ preview, mode, reducedMotion });
  settings.current = { preview, mode, reducedMotion };
  const [loadState, setLoadState] = useState('loading'), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ name: 'idle', trigger: 'idle' });
  useEffect(() => {
    // 暂停或预览期间收到的旧结果不重放；只有新到达的指令才能入队。
    if (previousActions.current === actions) return;
    previousActions.current = actions;
    if (!preview && !reducedMotion) machine.current.enqueue(actions);
  }, [actions, preview, reducedMotion]);

  useEffect(() => {
    let active = true, loaded = false, lastLabel = '', frames = 0, windowStart = performance.now();
    setLoadState('loading'); setError('');
    const failed = message => {
      if (!active) return;
      loaded = false; setError(message); setLoadState('error');
      player.current?.pause();
    };
    const timeout = setTimeout(() => failed('熊猫动画加载超时，请检查网络后重试。'), 20000);
    const resize = () => { if (loaded) player.current?.resizeDrawingSurfaceToCanvas(Math.min(window.devicePixelRatio || 1, 2)); };
    const instance = new Rive({
      src: RIVE_PET.src, artboard: RIVE_PET.artboard, stateMachine: RIVE_PET.stateMachine,
      canvas: canvas.current, autoplay: true, autoBind: true, enableRiveAssetCDN: false,
      layout: new Layout({ fit: Fit.Contain, alignment: Alignment.BottomCenter }),
      onLoad: () => {
        if (!active) return;
        clearTimeout(timeout);
        try {
          control.current = bindPetControl(instance); loaded = true;
          setLoadState('ready'); resize();
          const paused = settings.current.reducedMotion || settings.current.preview;
          machine.current.setEnabled(!paused);
          // 预览仍使用同一个 Rive 角色；不退回图片帧或独立位图姿势。
          control.current({ name: 'idle' });
          if (paused) instance.pause();
        } catch (cause) { failed(cause.message); }
      },
      onLoadError: () => { clearTimeout(timeout); failed('熊猫动画加载失败，请重试。'); },
      onAdvance: () => {
        if (!active || !loaded) return;
        const time = performance.now();
        const current = machine.current.tick(time);
        control.current(current);
        const label = `${current.name}:${current.trigger}`;
        if (label !== lastLabel) { lastLabel = label; setState(current); }
        if (stage.current) {
          stage.current.dataset.renderFrame = String(++frames);
          if (time - windowStart >= 1000) {
            stage.current.dataset.renderFps = String(Math.round(frames * 1000 / (time - windowStart)));
            frames = 0; windowStart = time;
          }
        }
      },
    });
    player.current = instance;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas.current);
    window.addEventListener('resize', resize);
    return () => {
      active = false; clearTimeout(timeout); observer?.disconnect(); window.removeEventListener('resize', resize);
      control.current = null; player.current = null;
      // 释放 WASM 内的实例、画板和 GPU 资源，热更新及页面切换不留下动画循环。
      instance.cleanup();
    };
  }, [attempt]);

  useEffect(() => {
    const paused = reducedMotion || preview;
    machine.current.setEnabled(!paused);
    if (loadState !== 'ready') return;
    if (paused) {
      player.current?.pause();
      runtimePaused.current = true;
      if (stage.current) stage.current.dataset.renderFps = '0';
    } else {
      if (runtimePaused.current) {
        // JS队列已经清空；同时重置真实Rive动作，防止标签闲置却续播旧动作。
        control.current?.({ name: 'idle', started: performance.now() });
        setState({ name: 'idle', trigger: 'idle' });
        runtimePaused.current = false;
      }
      player.current?.play();
    }
  }, [loadState, reducedMotion, preview]);

  return <div className="panda-stage" ref={stage} data-renderer="rive" data-action={state.name} data-trigger={state.trigger} data-load-state={loadState}>
    <canvas className="panda-frame" width="640" height="640" ref={canvas} role="img" aria-label={`Rive 熊猫小忆，${ACTION_LABELS[state.name]}`} />
    <button className="pet-touch" aria-label="摸摸小忆" title="点击摸摸小忆" disabled={preview || reducedMotion || loadState !== 'ready'} onClick={() => machine.current.enqueue([{ name: 'happy', trigger: 'explicit', duration_ms: 1900 }])} />
    {loadState !== 'ready' && <div className="asset-loading" role={loadState === 'error' ? 'alert' : 'status'}>{loadState === 'error' ? <>{error}<button onClick={() => setAttempt(value => value + 1)}>重试动画</button></> : '小忆正在准备见你…'}</div>}
    <div className="pet-action">{reducedMotion ? '安静陪着你' : ACTION_LABELS[state.name]}</div>
  </div>;
}
/** 消息头像是静态头像资源，动作只由上面的 Rive 画板执行。 */
export function PandaAvatar() { return <img className="panda-avatar" src="/assets/panda-rive-avatar.png" alt="小忆" />; }
