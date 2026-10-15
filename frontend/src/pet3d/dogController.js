import * as THREE from 'three';
import { PetBrain } from './petBrain.js';
import { DogAnimator } from './dogAnimator.js';
import { FOODS, COMMANDS, PET_ACTIONS } from './protocol.js';
import { glyphTexture, radialTexture } from './eyeTexture.js';

/** 狗活动的地毯范围（世界坐标），投喂、扔球都会夹到这里。 */
export const FLOOR = { minX: -1.25, maxX: 1.25, minZ: -0.9, maxZ: 0.9 };
const HOME = { x: 0, z: 0, yaw: 0.6 };
const clampFloor = (x, z) => [Math.max(FLOOR.minX, Math.min(FLOOR.maxX, x)), Math.max(FLOOR.minZ, Math.min(FLOOR.maxZ, z))];
const GLYPHS = { heart: ['❤', '#ff6f97'], zzz: ['Z', '#6f8fe8'], note: ['♪', '#7b6be0'], star: ['✦', '#ffb340'], bang: ['!', '#ff8a3d'], crumb: ['•', '#c58b52'], woof: ['汪', '#ff9a3c'] };

/**
 * 场景控制器：把大脑（决定做什么）、动画（怎么动）、道具和粒子串起来，
 * 并把用户交互上报给驱动。React 层只负责挂载和传递指针事件。
 */
export class DogController {
  constructor({ rig, driver, onSay, onState, random = Math.random, stats }) {
    this.rig = rig; this.driver = driver; this.onSay = onSay; this.onState = onState; this.random = random;
    this.clock = 0;
    this.brain = new PetBrain({ now: () => this.clock * 1000, random, stats });
    this.animator = new DogAnimator(rig, { random });
    this.animator.setHome(HOME.x, HOME.z, HOME.yaw);
    this.group = new THREE.Group();
    this.task = null; this.food = null; this.ball = null;
    this.particles = []; this.particleTextures = {}; this.emitCooldown = {};
    this.lookOverride = null; this.pointerLook = null; this.pointerSeen = -10;
    this.stroking = false; this.lastLabel = ''; this.saveDue = 15; this.statsDue = 0;
    this.pokes = [];
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.2), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(60,70,80,0.38)', 'rgba(60,70,80,0)'), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.002;
    this.group.add(this.shadow);
    this.camera = null;
  }

  /** 订阅驱动指令；与 dispose 分开，便于 React 严格模式重复挂载。 */
  connect() {
    this.unsubscribe?.();
    this.unsubscribe = this.driver?.subscribe(commands => this.handleCommands(commands));
    return () => { this.unsubscribe?.(); this.unsubscribe = null; };
  }

  setEnabled(enabled) { this.brain.setEnabled(enabled); if (!enabled) { this.animator.stop(); this.task = null; } }

  /** 服务端（或 mock）下发的指令。 */
  handleCommands(commands) {
    for (const command of commands) {
      switch (command.type) {
        case 'action': this.brain.enqueue([command]); break;
        case 'emotion': this.brain.setEmotion(command.name, command.intensity, command.duration_ms); break;
        case 'posture': this.brain.setPosture(command.name); break;
        case 'lookAt': this.lookOverride = { target: command.target, until: this.clock + command.duration_ms / 1000 }; break;
        case 'say': this.onSay?.(command.text, command.duration_ms); break;
        case 'stats': this.brain.setStats(command); this.publishStats(); break;
        case 'spawn': command.item === 'ball' ? this.throwBall() : this.placeFood(command.item); break;
        default: break;
      }
    }
  }

  /** 用户交互：先本地立即反应，再上报驱动，服务端可追加反应。 */
  interact(kind, detail = {}) {
    const brain = this.brain;
    brain.touch();
    const sleeping = brain.basePosture === 'sleep';
    if (sleeping && !['sleep', 'stroke', 'pet_head'].includes(kind)) { this.wake(); }
    switch (kind) {
      case 'pet_head':
        if (sleeping) { this.emit('heart', this.headPosition()); brain.applyStats({ affection: 1 }); break; }
        brain.enqueue([{ name: 'pet_head', trigger: 'explicit' }]);
        brain.applyStats({ mood: 4, affection: 1 });
        break;
      case 'stroke':
        brain.applyStats({ mood: 2, affection: 0.5 });
        if (!sleeping && brain.current?.name !== 'pet_head') brain.enqueue([{ name: 'pet_head', trigger: 'explicit' }]);
        break;
      case 'poke': {
        this.pokes = [...this.pokes.filter(time => this.clock - time < 2), this.clock];
        if (this.pokes.length >= 3) { this.pokes = []; return this.interact('tickle'); }
        brain.enqueue([{ name: 'poke', trigger: 'explicit' }]);
        break;
      }
      case 'tickle': brain.enqueue([{ name: 'tickle', trigger: 'explicit' }]); brain.applyStats({ mood: 5, affection: 1 }); break;
      case 'feed': this.placeFood(detail.item, detail.point); break;
      case 'throw_ball': this.throwBall(detail.point); break;
      case 'command': {
        if (!COMMANDS[detail.name]) return;
        if (brain.stats.energy < 8) { brain.enqueue([{ name: 'yawn', trigger: 'explicit' }]); this.onSay?.('好累呀，想睡觉了…', 3000); return; }
        brain.enqueue([{ name: detail.name, trigger: 'explicit' }]);
        brain.applyStats({ mood: 2, affection: 0.5, energy: -1 });
        break;
      }
      case 'sleep': this.cancelTask(); brain.setPosture('sleep'); break;
      case 'wake': this.wake(); break;
      default: return;
    }
    this.publishStats();
    this.driver?.report(kind, { ...detail, point: undefined }, brain.stats);
  }

  wake() {
    if (this.brain.basePosture !== 'sleep') return;
    this.brain.setPosture('stand');
    this.brain.enqueue([{ name: 'wake_up', trigger: 'explicit' }]);
  }

  // ---------- 投喂 ----------
  placeFood(item, point) {
    const food = FOODS[item];
    if (!food) return;
    this.cancelTask();
    this.removeFood();
    const a = this.animator;
    let [x, z] = point ? clampFloor(point.x, point.z) : clampFloor(a.position.x + Math.sin(a.yaw) * 0.85, a.position.y + Math.cos(a.yaw) * 0.85);
    const mesh = foodMesh(item);
    mesh.position.set(x, 0, z);
    this.group.add(mesh);
    this.food = { item, mesh, spec: food };
    this.emit('star', new THREE.Vector3(x, 0.35, z));
    // 走到碗前：停在碗的狗侧，头正好伸进碗里。
    const dx = a.position.x - x, dz = a.position.y - z, distance = Math.hypot(dx, dz) || 1;
    const stand = [x + dx / distance * 0.62, z + dz / distance * 0.62];
    const faceYaw = Math.atan2(x - stand[0], z - stand[1]);
    this.task = { kind: 'feed', phase: 'walk' };
    this.brain.enqueue([{ name: 'walk', trigger: 'explicit' }]);
    this.brain.setEmotion('excited', 0.9, 3000);
    a.moveTo(stand[0], stand[1], { speed: 1.1, faceYaw, arrive: () => {
      if (this.task?.kind !== 'feed') return;
      this.brain.finish('walk');
      this.task.phase = 'eat';
      this.brain.enqueue([{ name: food.action, trigger: 'explicit' }]);
    } });
  }

  removeFood() {
    if (!this.food) return;
    this.group.remove(this.food.mesh);
    this.food.mesh.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
    this.food = null;
  }

  /** 打断进行中的投喂/捡球：停下脚步，叼着的球掉到地上。 */
  cancelTask() {
    this.animator.stop();
    this.brain.finish('walk'); this.brain.finish('fetch');
    this.ballFlight = null;
    if (this.ball && this.ball.parent !== this.group) {
      this.group.attach(this.ball);
      this.ball.position.y = 0.07; this.ball.rotation.set(0, 0, 0);
    }
    this.task = null;
  }

  // ---------- 扔球 ----------
  throwBall(point) {
    if (this.task?.kind === 'fetch') return;
    this.cancelTask();
    if (!this.ball) { this.ball = ballMesh(); this.group.add(this.ball); }
    const [x, z] = point ? clampFloor(point.x, point.z) : clampFloor((this.random() - 0.5) * 2.3, -0.5 + this.random() * 1.2);
    const start = new THREE.Vector3(0.5, 1.7, 2.6);
    this.ballFlight = { start, end: new THREE.Vector3(x, 0.07, z), t: 0, duration: 0.85 };
    this.task = { kind: 'fetch', phase: 'flight' };
    this.animator.stop();
    this.brain.enqueue([{ name: 'fetch', trigger: 'explicit' }]);
    this.brain.setEmotion('excited', 1, 6000);
  }

  updateBall(dt) {
    const flight = this.ballFlight;
    if (!flight || !this.ball) return;
    flight.t += dt;
    const p = Math.min(1, flight.t / flight.duration);
    if (p < 1) {
      this.ball.position.lerpVectors(flight.start, flight.end, p);
      this.ball.position.y = THREE.MathUtils.lerp(flight.start.y, flight.end.y, p) + Math.sin(p * Math.PI) * 0.6;
    } else {
      // 两次小弹跳后停下。
      const after = flight.t - flight.duration;
      const bounce = after < 0.35 ? Math.sin(after / 0.35 * Math.PI) * 0.16 : after < 0.55 ? Math.sin((after - 0.35) / 0.2 * Math.PI) * 0.05 : 0;
      this.ball.position.set(flight.end.x, 0.07 + bounce, flight.end.z);
      if (after >= 0.55) { this.ballFlight = null; this.chaseBall(); }
    }
    this.ball.rotation.x += dt * 8;
  }

  chaseBall() {
    if (this.task?.kind !== 'fetch') return;
    const a = this.animator, ball = this.ball.position;
    const dx = a.position.x - ball.x, dz = a.position.y - ball.z, distance = Math.hypot(dx, dz) || 1;
    this.task.phase = 'chase';
    a.moveTo(ball.x + dx / distance * 0.5, ball.z + dz / distance * 0.5, { speed: 1.7, faceYaw: Math.atan2(-dx, -dz), arrive: () => {
      if (this.task?.kind !== 'fetch') return;
      this.task.phase = 'pickup'; this.task.until = this.clock + 0.45;
    } });
  }

  updateTask(snapshot) {
    const task = this.task;
    if (!task) return;
    if (task.kind === 'feed' && task.phase === 'eat') {
      const name = snapshot.action?.name;
      if (name === 'eat' || name === 'drink') {
        const remaining = 1 - snapshot.action.progress;
        this.food?.mesh.userData.content?.scale.setScalar(Math.max(0.05, remaining));
        if (this.random() < 0.08 && name === 'eat') this.emit('crumb', this.mouthPosition());
        task.eating = true;
      } else if (task.eating) {
        const spec = this.food?.spec;
        if (spec) this.brain.applyStats({ hunger: spec.hunger, mood: spec.mood, energy: spec.energy || 0, affection: 1 });
        this.removeFood();
        this.emit('heart', this.headPosition());
        this.publishStats();
        this.task = { kind: 'return' };
        this.goHome();
      }
    }
    if (task.kind === 'fetch' && task.phase === 'pickup' && this.clock >= task.until) {
      this.rig.mouthItem.attach(this.ball);
      this.ball.position.set(0, 0, 0.02);
      task.phase = 'return';
      this.goHome(() => {
        if (this.task?.kind !== 'fetch') return;
        // 把球放在主人面前。
        this.group.attach(this.ball);
        const a = this.animator;
        this.ball.position.set(a.position.x + Math.sin(a.yaw) * 0.6, 0.07, a.position.y + Math.cos(a.yaw) * 0.6);
        this.ball.rotation.set(0, 0, 0);
        this.task = null;
        this.brain.finish('fetch');
        this.brain.applyStats({ mood: 8, affection: 2, energy: -5 });
        this.publishStats();
        this.driver?.report('fetch_done', {}, this.brain.stats);
      });
    }
  }

  goHome(arrive) {
    this.brain.enqueue([{ name: 'walk', trigger: 'explicit' }]);
    this.animator.moveTo(HOME.x, HOME.z, { speed: 1.2, faceYaw: HOME.yaw, arrive: () => {
      this.brain.finish('walk');
      if (this.task?.kind === 'return') this.task = null;
      arrive?.();
    } });
  }

  // ---------- 指针与注视 ----------
  setPointer(point) { this.pointerLook = point; this.pointerSeen = this.clock; }

  lookTarget() {
    if (this.lookOverride && this.clock < this.lookOverride.until) {
      const target = this.lookOverride.target;
      if (target === 'item') return this.ball?.position || this.food?.mesh.position || null;
      if (target !== 'user') return new THREE.Vector3(target.x, target.y, target.z);
    }
    if (this.task?.kind === 'fetch' && this.ball) return this.ball.getWorldPosition(new THREE.Vector3());
    if (this.pointerLook && this.clock - this.pointerSeen < 3) return this.pointerLook;
    return this.camera ? this.camera.position : new THREE.Vector3(0, 1.4, 5);
  }

  headPosition() { return this.rig.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.45, 0)); }
  mouthPosition() { return this.rig.mouthItem.getWorldPosition(new THREE.Vector3()); }

  // ---------- 粒子 ----------
  emit(kind, position, count = 1) {
    const [glyph, color] = GLYPHS[kind] || GLYPHS.heart;
    this.particleTextures[kind] ||= glyphTexture(glyph, color);
    for (let i = 0; i < count; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.particleTextures[kind], transparent: true, depthWrite: false }));
      const size = kind === 'crumb' ? 0.06 : kind === 'zzz' ? 0.16 + this.random() * 0.06 : 0.18;
      sprite.scale.setScalar(size);
      sprite.position.copy(position).add(new THREE.Vector3((this.random() - 0.5) * 0.3, 0, (this.random() - 0.5) * 0.2));
      const velocity = kind === 'crumb' ? new THREE.Vector3((this.random() - 0.5) * 0.4, 0.5, (this.random() - 0.5) * 0.4) : new THREE.Vector3((this.random() - 0.5) * 0.15, 0.45 + this.random() * 0.2, 0);
      this.group.add(sprite);
      this.particles.push({ sprite, velocity, life: 0, max: kind === 'zzz' ? 2.2 : 1.4, size, gravity: kind === 'crumb' ? -2.5 : 0 });
    }
  }

  emitThrottled(kind, interval, position) {
    if ((this.emitCooldown[kind] || 0) > this.clock) return;
    this.emitCooldown[kind] = this.clock + interval;
    this.emit(kind, position);
  }

  updateParticles(dt) {
    this.particles = this.particles.filter(particle => {
      particle.life += dt;
      particle.velocity.y += particle.gravity * dt;
      particle.sprite.position.addScaledVector(particle.velocity, dt);
      const fade = particle.life / particle.max;
      particle.sprite.material.opacity = 1 - fade * fade;
      particle.sprite.scale.setScalar(particle.size * (0.7 + Math.min(1, particle.life * 4) * 0.3 + fade * 0.2));
      if (particle.life < particle.max) return true;
      this.group.remove(particle.sprite); particle.sprite.material.dispose();
      return false;
    });
  }

  // ---------- 每帧更新 ----------
  update(dt) {
    dt = Math.min(dt, 0.05);
    this.clock += dt;
    this.brain.decay(dt * 1000);
    const snapshot = this.brain.tick();
    this.updateBall(dt);
    this.updateTask(snapshot);
    const face = this.animator.update(dt, snapshot, { lookTarget: this.lookTarget(), stroking: this.stroking });
    const head = this.headPosition();
    if (face.hearts || this.stroking) this.emitThrottled('heart', 0.45, head);
    if (face.zzz) this.emitThrottled('zzz', 0.9, head.clone().add(new THREE.Vector3(0.2, 0, 0)));
    if (face.notes) this.emitThrottled('note', 0.35, head);
    if (face.bang) this.emitThrottled('bang', 1, head);
    if (face.bark) this.emitThrottled('woof', 0.5, head);
    if (snapshot.emotion.name === 'love') this.emitThrottled('heart', 1.2, head);
    this.updateParticles(dt);
    const a = this.animator;
    this.shadow.position.set(a.position.x, 0.002, a.position.y);
    this.shadow.rotation.z = -a.yaw;
    const lift = Math.max(0, this.rig.hips.position.y - this.rig.hips.userData.restPosition.y);
    this.shadow.scale.setScalar(1 - Math.min(0.35, lift * 1.5));
    this.publishState(snapshot);
    this.statsDue -= dt; this.saveDue -= dt;
    if (this.statsDue <= 0) { this.statsDue = 2; this.publishStats(); }
    if (this.saveDue <= 0) { this.saveDue = 15; this.driver?.saveState(this.brain.stats); }
  }

  publishState(snapshot) {
    const name = snapshot.action?.name || (snapshot.posture === 'sleep' ? 'sleep' : 'idle');
    const label = name === 'idle' && this.task?.kind === 'fetch' ? PET_ACTIONS.fetch.label : PET_ACTIONS[name]?.label || PET_ACTIONS.idle.label;
    const key = `${name}|${label}|${snapshot.posture}`;
    if (key === this.lastLabel) return;
    this.lastLabel = key;
    this.onState?.({ name, label, posture: snapshot.posture, sleeping: this.brain.basePosture === 'sleep' });
  }

  publishStats() { this.onState?.({ stats: { ...this.brain.stats } }); }

  dispose() {
    this.unsubscribe?.();
    this.driver?.saveState(this.brain.stats);
    this.removeFood();
    this.particles.forEach(particle => particle.sprite.material.dispose());
    Object.values(this.particleTextures).forEach(texture => texture.dispose());
    this.ball?.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
    this.shadow.geometry.dispose(); this.shadow.material.map.dispose(); this.shadow.material.dispose();
  }
}

/** 食盆 + 食物；content 子节点随进食缩小。 */
function foodMesh(item) {
  const holder = new THREE.Group();
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.1, 40, 1, true), new THREE.MeshPhysicalMaterial({ color: '#7fd8c4', roughness: 0.35, clearcoat: 0.6, side: THREE.DoubleSide }));
  bowl.position.y = 0.05; holder.add(bowl);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 12, 40), new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.3 }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.1; holder.add(rim);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), new THREE.MeshStandardMaterial({ color: '#5bb9a6' }));
  bottom.rotation.x = -Math.PI / 2; bottom.position.y = 0.005; holder.add(bottom);
  const content = new THREE.Group(); content.position.y = 0.06; holder.add(content);
  if (item === 'milk') {
    const milk = new THREE.Mesh(new THREE.CircleGeometry(0.18, 32), new THREE.MeshPhysicalMaterial({ color: '#fffaf0', roughness: 0.2, clearcoat: 1 }));
    milk.rotation.x = -Math.PI / 2; milk.position.y = 0.025; content.add(milk);
  } else if (item === 'bone') {
    const material = new THREE.MeshPhysicalMaterial({ color: '#f6ead2', roughness: 0.6 });
    const shaft = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.22, 6, 12), material); shaft.rotation.z = Math.PI / 2; shaft.position.y = 0.06; content.add(shaft);
    for (const x of [-0.14, 0.14]) for (const z of [-0.03, 0.03]) { const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), material); knob.position.set(x, 0.06, z); content.add(knob); }
  } else {
    const material = new THREE.MeshPhysicalMaterial({ color: '#b5643a', roughness: 0.55, clearcoat: 0.3 });
    for (let i = 0; i < 5; i++) { const piece = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.05), material); piece.position.set((i % 3 - 1) * 0.07, 0.03 + Math.floor(i / 3) * 0.03, (i % 2 - 0.5) * 0.08); piece.rotation.y = i * 1.1; content.add(piece); }
  }
  holder.userData.content = content;
  return holder;
}

function ballMesh() {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffd34d'; ctx.fillRect(0, 0, 128, 64);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6; ctx.beginPath();
  for (let x = 0; x <= 128; x += 4) ctx.lineTo(x, 32 + Math.sin(x / 128 * Math.PI * 4) * 14);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 16), new THREE.MeshPhysicalMaterial({ map: texture, roughness: 0.7, sheen: 0.8, sheenColor: new THREE.Color('#fff6c0') }));
  ball.name = 'ball';
  return ball;
}
