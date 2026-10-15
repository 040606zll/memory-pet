import { useEffect, useRef, useState } from 'react';
import { HandPalm, Eye, PawPrint } from '@phosphor-icons/react';
import { ACTION_LABELS } from './petMachine.js';
import { DogBehavior } from './dogBehavior.js';
import { SPRITE_DURATIONS } from './dogSpriteAssets.js';
import { loadCoherentDogSprites } from './dogFrameAtlas.js';
import { DogSpriteRenderer, SpriteClock, spriteFrame } from './dogSpritePlayer.js';

/** 预绘制的真实姿态图集逐帧播放；角色不再进行单图网格形变。 */
export function RobotDog({ name = '小忆', actions = [], preview = false, reducedMotion = false }) {
  const canvas = useRef(null), stage = useRef(null), renderer = useRef(null);
  const clock = useRef(new SpriteClock());
  const machine = useRef(new DogBehavior({ durations: SPRITE_DURATIONS, now: () => clock.current.time }));
  const previousActions = useRef(null), frame = useRef(null), lastLabel = useRef('');
  const wasPaused = useRef(preview || reducedMotion);
  const settings = useRef({ preview, reducedMotion }); settings.current = { preview, reducedMotion };
  const [state, setState] = useState({ name: 'idle', trigger: 'idle' });
  const [loadState, setLoadState] = useState('loading'), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (previousActions.current === actions) return;
    previousActions.current = actions;
    if (!preview && !reducedMotion) machine.current.enqueue(actions);
  }, [actions, preview, reducedMotion]);

  useEffect(() => {
    let active = true, assets, count = 0, sourceCount = 0, windowStart = performance.now(), previousTime = 0, maxGap = 0;
    const controller = new AbortController();
    setLoadState('loading'); setError('');
    const fail = message => { if (active) { setError(message); setLoadState('error'); } };
    const timeout = setTimeout(() => { controller.abort(); fail('机器狗动作加载超时，请重试。'); }, 20000);
    const render = wallTime => {
      if (!active || !renderer.current) return;
      const paused = settings.current.preview || settings.current.reducedMotion;
      if (!paused && !document.hidden) {
        // 间隔统计按实际刷新回调计算，安静时不重画不能被误报为长时间掉帧。
        if (previousTime) maxGap = Math.max(maxGap, wallTime - previousTime);
        previousTime = wallTime;
        const time = clock.current.advance(wallTime), current = machine.current.tick(time);
        const sample = spriteFrame(assets, current, time), before = renderer.current.stats.sourceFrames;
        const label = `${current.name}:${current.trigger}`;
        if (label !== lastLabel.current) { lastLabel.current = label; setState(current); }
        if (renderer.current.draw(sample, time)) {
          const stats = renderer.current.stats; count++; sourceCount += stats.sourceFrames - before;
          if (stage.current) {
            stage.current.dataset.renderFrame = String(stats.frames);
            stage.current.dataset.sourceFrames = String(stats.sourceFrames);
            stage.current.dataset.spriteIndex = String(sample.index);
            stage.current.dataset.blankFrames = String(stats.blankFrames);
            stage.current.dataset.bufferResizes = String(stats.resizes);
            stage.current.dataset.maxFrameGap = String(Math.round(maxGap));
          }
        }
        if (wallTime - windowStart >= 1000 && stage.current) {
          stage.current.dataset.renderFps = String(Math.round(count * 1000 / (wallTime - windowStart)));
          stage.current.dataset.spriteFps = String(Math.round(sourceCount * 1000 / (wallTime - windowStart)));
          count = sourceCount = 0; windowStart = wallTime;
        }
      } else { clock.current.pause(); previousTime = 0; count = sourceCount = 0; windowStart = wallTime; }
      frame.current = requestAnimationFrame(render);
    };
    loadCoherentDogSprites(controller.signal).then(loaded => {
      clearTimeout(timeout);
      if (!active) { loaded.release(); return; }
      assets = loaded;
      try {
        renderer.current = new DogSpriteRenderer(canvas.current, { diagnose: new URLSearchParams(window.location.search).has('pet-debug') });
        renderer.current.draw(spriteFrame(assets, { name: 'idle', started: 0, progress: 0 }, 0), 0);
        if (stage.current) { stage.current.dataset.uniqueFrames = String(assets.manifest.uniqueFrames || 0); stage.current.dataset.decodedBytes = String(assets.manifest.decodedBytes || 0); }
        setLoadState('ready'); clock.current.pause(); frame.current = requestAnimationFrame(render);
      } catch (cause) { loaded.release(); fail(cause.message); }
    }).catch(cause => { clearTimeout(timeout); if (cause.name !== 'AbortError') fail(cause.message); });
    return () => { active = false; clearTimeout(timeout); controller.abort(); cancelAnimationFrame(frame.current); renderer.current?.dispose(); renderer.current = null; assets?.release(); };
  }, [attempt]);

  useEffect(() => {
    const paused = preview || reducedMotion; machine.current.setEnabled(!paused);
    if (paused) {
      clock.current.pause();
      if (stage.current) { stage.current.dataset.renderFps = '0'; stage.current.dataset.spriteFps = '0'; }
    } else if (wasPaused.current) { renderer.current?.resume(); lastLabel.current = ''; setState({ name: 'idle', trigger: 'idle' }); }
    wasPaused.current = paused;
  }, [preview, reducedMotion]);

  const perform = name => machine.current.enqueue([{ name, trigger: 'explicit' }]);
  const actionLabel = state.name === 'idle' ? '正在陪着你' : ACTION_LABELS[state.name];
  const disabled = preview || reducedMotion || loadState !== 'ready';
  return <div className="panda-stage robot-dog-stage" ref={stage} data-renderer="spritesheet" data-animation-version="coherent-v2" data-action={state.name} data-trigger={state.trigger} data-load-state={loadState}>
    <canvas className="panda-frame robot-dog-frame" ref={canvas} width="640" height="700" role="img" aria-label={`机器狗${name}，${actionLabel}`} />
    <button className="pet-touch" aria-label={`摸摸${name}`} title={`点击摸摸${name}`} disabled={disabled} onClick={() => perform('happy')} />
    {loadState !== 'ready' && <div className="asset-loading" role={loadState === 'error' ? 'alert' : 'status'}>{loadState === 'error' ? <>{error}<button onClick={() => setAttempt(value => value + 1)}>重试动画</button></> : `${name}正在准备动作…`}</div>}
    <div className="dog-controls" aria-label="和机器狗互动"><button disabled={disabled} onClick={() => perform('happy')}><HandPalm weight="fill" /><span>摸摸头</span></button><button disabled={disabled} onClick={() => perform('blink')}><Eye weight="fill" /><span>眨眨眼</span></button><button disabled={disabled} onClick={() => perform('wag_tail')}><PawPrint weight="fill" /><span>摇尾巴</span></button></div>
    <div className="pet-action dog-action">{reducedMotion ? '安静陪着你' : actionLabel}</div>
  </div>;
}

/** 静态头像继续使用原稿同一只狗，动作主体使用连续姿态图集。 */
export function RobotDogAvatar({ name = '小忆' }) { return <span className="panda-avatar robot-dog-avatar" role="img" aria-label={name}><img src="/assets/robot-dog-reference.png" alt="" /></span>; }
