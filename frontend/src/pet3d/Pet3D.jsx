import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HandPalm, Bone, Baseball, Megaphone, Moon, Sun, Cookie, Drop, ForkKnife, Smiley, Lightning, X } from '@phosphor-icons/react';
import { loadDogModel } from './dogModel.js';
import { DogController } from './dogController.js';
import { createPetDriver } from './petDriver.js';
import { COMMANDS, FOODS } from './protocol.js';
import { DEFAULT_STATS } from './petBrain.js';
import './pet3d.css';

const FOOD_ICONS = { bone: Bone, jerky: Cookie, milk: Drop };
const LOOK_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.8);
const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();

/** 画布内的场景：灯光、环境反射、狗和道具；每帧驱动控制器。 */
function DogScene({ model, driver, paused, controllerRef, onSay, onState, initialStats }) {
  const { camera, gl, scene, size } = useThree();
  const controller = useMemo(() => new DogController({ rig: model.rig, driver, onSay: (...args) => onSay.current?.(...args), onState: state => onState.current?.(state), stats: initialStats }), [model, driver, onSay, onState, initialStats]);
  const press = useRef(null);

  useEffect(() => {
    controllerRef.current = controller; controller.camera = camera;
    // ?pet-debug 时暴露控制器，便于在控制台调试姿态与指令。
    if (new URLSearchParams(window.location.search).has('pet-debug')) window.__pet = controller;
    const disconnect = controller.connect();
    return () => { disconnect(); controller.dispose(); controllerRef.current = null; };
  }, [controller, camera, controllerRef]);
  useEffect(() => { controller.setEnabled(!paused); }, [controller, paused]);

  // 竖长画面时加大视角，保证地毯左右都在画面内。
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const halfWidth = 1.4, distance = camera.position.distanceTo(new THREE.Vector3(0, 0.6, 0));
    const needed = THREE.MathUtils.radToDeg(2 * Math.atan(halfWidth / distance / aspect));
    camera.fov = Math.max(26, Math.min(44, needed));
    camera.lookAt(0, 0.82, 0);
    camera.updateProjectionMatrix();
  }, [camera, size]);

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment; scene.environmentIntensity = 0.4;
    return () => { scene.environment = null; environment.dispose(); pmrem.dispose(); };
  }, [gl, scene]);

  useFrame((_, delta) => { if (!paused) controller.update(delta); });

  // 指针按在头上拖动 = 抚摸；轻点头 = 摸摸头；点身体 = 戳一下。
  const partOf = object => { for (let node = object; node; node = node.parent) { if (node.name === 'head') return 'head'; if (node.name === 'dog') return 'body'; } return 'body'; };
  useEffect(() => {
    const end = () => {
      const current = press.current; press.current = null;
      if (!current) return;
      controller.stroking = false;
      if (!current.stroked) controller.interact(current.part === 'head' ? 'pet_head' : 'poke');
      document.body.style.cursor = '';
    };
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, [controller]);
  const onDown = event => {
    if (paused) return;
    event.stopPropagation();
    press.current = { part: partOf(event.object), x: event.clientX, y: event.clientY, distance: 0, stroked: false, lastStroke: 0 };
    if (press.current.part === 'head') document.body.style.cursor = 'grabbing';
  };
  const onMove = event => {
    const current = press.current;
    if (!current || current.part !== 'head') return;
    current.distance += Math.hypot(event.clientX - current.x, event.clientY - current.y);
    current.x = event.clientX; current.y = event.clientY;
    if (current.distance > 50) {
      controller.stroking = true; current.stroked = true;
      if (controller.clock - current.lastStroke > 1.2) { current.lastStroke = controller.clock; controller.interact('stroke'); }
    }
  };
  const onOver = event => { if (!paused && !press.current) document.body.style.cursor = partOf(event.object) === 'head' ? 'grab' : 'pointer'; };
  const onOut = () => { if (!press.current) document.body.style.cursor = ''; };
  const onPropClick = event => { if (!paused && event.object.name === 'ball') { event.stopPropagation(); controller.interact('throw_ball'); } };

  return <>
    <hemisphereLight args={['#dceeff', '#cbb8a2', 0.75]} />
    {/* 主光来自左上的窗户，投射柔和阴影，让耳朵、腿和下巴有体积。 */}
    <directionalLight position={[-3, 5, 3]} intensity={1.9} color="#fff3e2" castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0004} shadow-normalBias={0.03} shadow-radius={4}
      shadow-camera-left={-2.5} shadow-camera-right={2.5} shadow-camera-top={3} shadow-camera-bottom={-1} shadow-camera-near={1} shadow-camera-far={14} />
    <directionalLight position={[3, 2, 3]} intensity={0.4} color="#d8e9ff" />
    <directionalLight position={[0.5, 3, -4]} intensity={0.9} color="#ffffff" />
    <primitive object={model.object} onPointerDown={onDown} onPointerMove={onMove} onPointerOver={onOver} onPointerOut={onOut} />
    <primitive object={controller.group} onClick={onPropClick} />
  </>;
}

/** 3D 宠物主体：画布 + 状态栏 + 互动按钮。props 与旧 RobotDog 一致，另有 onSay/userId。 */
export default function Pet3D({ name = '小忆', actions = [], preview = false, reducedMotion = false, onSay, userId }) {
  const paused = preview || reducedMotion;
  const driver = useMemo(() => createPetDriver({ userId: userId || 'anonymous' }), [userId]);
  const controllerRef = useRef(null), stageRef = useRef(null), previousActions = useRef(actions);
  const sayRef = useRef(onSay); sayRef.current = onSay;
  const [status, setStatus] = useState({ name: 'idle', label: '正在陪着你', sleeping: false });
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [initialStats, setInitialStats] = useState(null);
  const [model, setModel] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [tray, setTray] = useState(null);
  const [drag, setDrag] = useState(null);
  const stateRef = useRef(null);
  stateRef.current = update => {
    if (update.stats) setStats(update.stats);
    if (update.label) setStatus(update);
  };

  useEffect(() => {
    let active = true;
    driver.loadState().then(state => { if (active) setInitialStats({ ...DEFAULT_STATS, ...(state?.stats || {}) }); });
    driver.connect();
    return () => { active = false; driver.dispose(); };
  }, [driver]);

  // 模型只加载一次；加载失败交给外层错误边界，退回 2D 版。
  useEffect(() => {
    let active = true, loaded = null;
    loadDogModel().then(result => { loaded = result; if (active) setModel(result); else result.dispose(); }).catch(error => { if (active) setLoadError(error); });
    return () => { active = false; loaded?.dispose(); };
  }, []);
  if (loadError) throw loadError;

  // 聊天回复里的动作（旧协议）交给驱动统一处理；暂停期间的动作不补放。
  useEffect(() => {
    if (previousActions.current === actions) return;
    previousActions.current = actions;
    if (!paused && actions?.length) driver.dispatch(actions);
  }, [actions, paused, driver]);

  const interact = useCallback((kind, detail) => { controllerRef.current?.interact(kind, detail); setTray(null); }, []);

  const pointerToNdc = (clientX, clientY) => {
    const rect = stageRef.current.querySelector('canvas')?.getBoundingClientRect();
    if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    return new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  };
  const rayPoint = (ndc, plane) => {
    const camera = controllerRef.current?.camera;
    if (!camera || !ndc) return null;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  };
  const onStageMove = event => {
    if (paused || drag) return;
    const point = rayPoint(pointerToNdc(event.clientX, event.clientY), LOOK_PLANE);
    if (point) controllerRef.current?.setPointer(point);
  };

  // 食物托盘：点击放到狗面前，拖到地上则放在落点。
  const startFoodDrag = (item, event) => {
    event.preventDefault();
    setDrag({ item, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
  };
  useEffect(() => {
    if (!drag) return;
    const move = event => setDrag(current => current && { ...current, x: event.clientX, y: event.clientY });
    const up = event => {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 8;
      const point = moved ? rayPoint(pointerToNdc(event.clientX, event.clientY), FLOOR_PLANE) : null;
      if (!moved || point) interact('feed', { item: drag.item, point: point || undefined });
      setDrag(null);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    // drag.item/start 不变时无需重绑，位置更新通过函数式 setState。
  }, [drag?.item, drag?.startX, drag?.startY]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = Boolean(initialStats && model);
  const disabled = paused || !ready;
  const DragIcon = drag ? FOOD_ICONS[drag.item] : null;
  const label = reducedMotion ? '安静陪着你' : status.label;
  return <div className="panda-stage pet3d-stage" ref={stageRef} data-renderer="webgl" data-action={status.name} data-posture={status.posture} onPointerMove={onStageMove}>
    {ready && <Canvas className="pet3d-canvas" shadows="soft" frameloop={paused ? 'demand' : 'always'} dpr={[1, 1.75]} camera={{ position: [0, 1.5, 5.8], fov: 30, near: 0.1, far: 50 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 0.95; }}
      aria-label={`3D 机器狗${name}，${label}`} role="img">
      <DogScene model={model} driver={driver} paused={paused} controllerRef={controllerRef} onSay={sayRef} onState={stateRef} initialStats={initialStats} />
    </Canvas>}
    {!ready && <div className="asset-loading" role="status">{name}正在醒来…</div>}
    <div className="pet3d-stats" aria-label={`${name}的状态`}>
      <Stat icon={ForkKnife} label="饱食" value={stats.hunger} tone="food" />
      <Stat icon={Smiley} label="心情" value={stats.mood} tone="mood" />
      <Stat icon={Lightning} label="精力" value={stats.energy} tone="energy" />
    </div>
    {!tray && <div className="pet-action dog-action" aria-live="polite">{label}</div>}
    {tray === 'food' && <div className="pet3d-tray" role="menu" aria-label="选择食物">
      {Object.entries(FOODS).map(([key, food]) => { const Icon = FOOD_ICONS[key]; return <button key={key} role="menuitem" disabled={disabled} onPointerDown={event => startFoodDrag(key, event)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); interact('feed', { item: key }); } }} title={`点击喂${food.label}，或拖到地上`}><Icon weight="fill" /><span>{food.label}</span></button>; })}
      <span className="pet3d-tray-hint">点击喂食，或拖到地毯上</span>
    </div>}
    {tray === 'command' && <div className="pet3d-tray commands" role="menu" aria-label="选择口令">
      {Object.entries(COMMANDS).map(([key, text]) => <button key={key} role="menuitem" disabled={disabled} onClick={() => interact('command', { name: key })}>{text}</button>)}
    </div>}
    <div className="dog-controls pet3d-controls" aria-label={`和${name}互动`}>
      <button disabled={disabled} onClick={() => interact('pet_head')}><HandPalm weight="fill" /><span>摸摸头</span></button>
      <button disabled={disabled} aria-expanded={tray === 'food'} onClick={() => setTray(tray === 'food' ? null : 'food')}>{tray === 'food' ? <X weight="bold" /> : <Bone weight="fill" />}<span>投喂</span></button>
      <button disabled={disabled} onClick={() => interact('throw_ball')}><Baseball weight="fill" /><span>扔球</span></button>
      <button disabled={disabled} aria-expanded={tray === 'command'} onClick={() => setTray(tray === 'command' ? null : 'command')}>{tray === 'command' ? <X weight="bold" /> : <Megaphone weight="fill" />}<span>口令</span></button>
      <button disabled={disabled} onClick={() => interact(status.sleeping ? 'wake' : 'sleep')}>{status.sleeping ? <Sun weight="fill" /> : <Moon weight="fill" />}<span>{status.sleeping ? '叫醒' : '哄睡'}</span></button>
    </div>
    {drag && DragIcon && <div className="pet3d-drag" style={{ left: drag.x, top: drag.y }} aria-hidden="true"><DragIcon weight="fill" /></div>}
  </div>;
}

function Stat({ icon: Icon, label, value, tone }) {
  const rounded = Math.round(value);
  return <div className={`pet3d-stat ${tone} ${rounded < 30 ? 'low' : ''}`} title={`${label} ${rounded}/100`}>
    <Icon weight="fill" /><span className="pet3d-stat-label">{label}</span><span className="pet3d-stat-track"><span style={{ width: `${rounded}%` }} /></span>
  </div>;
}
