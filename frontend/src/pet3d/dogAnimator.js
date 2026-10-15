import * as THREE from 'three';

/**
 * 程序化动画：姿态（平滑过渡）+ 动作叠加层 + 行走循环 + 注视 + 耳尾弹簧 + 眨眼。
 * 所有角度为相对 rest 的弧度；正 pitch 为低头/前倾（绕 x 轴），yaw 为绕 y 轴转向。
 */
const PARAMS = [
  'hipsY', 'hipsZ', 'hipsPitch', 'hipsRoll', 'hipsYaw', 'chestPitch', 'neckPitch', 'neckYaw', 'headPitch', 'headYaw', 'headRoll',
  'flA', 'flB', 'flZ', 'frA', 'frB', 'frZ', 'blA', 'blB', 'blZ', 'brA', 'brB', 'brZ',
  'earL', 'earR', 'jaw', 'tongue', 'tailUp', 'wagAmp', 'wagFreq', 'spinYaw', 'breath',
];
const zero = () => Object.fromEntries(PARAMS.map(key => [key, 0]));

export const POSTURE_POSES = {
  stand: {},
  sit: { hipsY: -0.19, hipsZ: -0.1, hipsPitch: -0.6, neckPitch: 0.26, headPitch: 0.3, flA: 0.62, frA: 0.62, blA: -0.55, blB: 1.45, brA: -0.55, brB: 1.45, blZ: -0.2, brZ: 0.2, tailUp: 0.5 },
  lie: { hipsY: -0.22, hipsPitch: 0.02, flA: -1.3, flB: 0.12, frA: -1.3, frB: 0.12, blA: -1.3, blB: 2.25, brA: -1.3, brB: 2.25, blZ: -0.35, brZ: 0.35, neckPitch: -0.12, headPitch: 0.1, tailUp: 0.6 },
  sleep: { hipsY: -0.24, hipsPitch: 0.04, flA: -1.35, flB: 0.1, frA: -1.35, frB: 0.1, blA: -1.3, blB: 2.25, brA: -1.3, brB: 2.25, blZ: -0.35, brZ: 0.35, neckPitch: 0.12, headPitch: 0.1, headRoll: 0.28, headYaw: 0.25, earL: -0.25, earR: -0.25, tailUp: 0.9 },
};

/** 情绪决定默认表情、嘴、耳朵与尾巴节奏。 */
const EMOTION_STYLE = {
  neutral: { eyes: 'open', jaw: 0.2, tongue: 0.75, wagAmp: 0.22, wagFreq: 1.3, headRoll: 0.1 },
  happy: { eyes: 'open', jaw: 0.3, tongue: 0.9, wagAmp: 0.5, wagFreq: 2.6, ears: 0.12, headRoll: 0.1 },
  excited: { eyes: 'happy', jaw: 0.42, tongue: 1, wagAmp: 0.7, wagFreq: 4, ears: 0.2, bounce: 0.025 },
  love: { eyes: 'heart', jaw: 0.25, tongue: 0.7, wagAmp: 0.5, wagFreq: 2.2, ears: -0.15 },
  sad: { eyes: 'sad', jaw: 0, tongue: 0, wagAmp: 0.06, wagFreq: 0.8, ears: -0.3, tailUp: 0.7, headPitch: 0.14 },
  sleepy: { eyes: 'sleepy', jaw: 0.02, tongue: 0, wagAmp: 0.04, wagFreq: 0.6, ears: -0.22, tailUp: 0.4 },
  curious: { eyes: 'open', jaw: 0.1, tongue: 0.2, wagAmp: 0.3, wagFreq: 1.6, ears: 0.3, headRoll: 0.26 },
  surprised: { eyes: 'surprised', jaw: 0.28, tongue: 0, wagAmp: 0.1, wagFreq: 1, ears: 0.42 },
  angry: { eyes: 'sad', jaw: 0.05, tongue: 0, wagAmp: 0, wagFreq: 1, ears: -0.1 },
};

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ease = x => x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
const wave = (t, hz, phase = 0) => Math.sin((t * hz + phase) * Math.PI * 2);
/** 动作淡入淡出包络，首尾都回到姿态本身，避免跳变。 */
const envelope = (elapsed, duration, fade = 0.28) => duration > 0 ? smooth(0, fade, elapsed) * (1 - smooth(duration - fade, duration, elapsed)) : smooth(0, fade, elapsed);

/** 每个动作写入：S（会被平滑的目标偏移）、F（直接叠加的快速振荡）、face（表情覆盖）。 */
export const ACTION_LAYERS = {
  blink: ({ face }) => { face.blink = true; },
  wave: ({ t, e, F, face }) => { F.frA -= 1.75 * e; F.frZ += (0.25 + 0.3 * wave(t, 2.2)) * e; F.headRoll += 0.15 * e; face.eyes = 'happy'; },
  nod: ({ t, e, F }) => { F.headPitch += 0.24 * wave(t, 1.9) * e; F.neckPitch += 0.06 * wave(t, 1.9) * e; },
  shake_head: ({ t, e, F }) => { F.headYaw += 0.38 * wave(t, 2.3) * e; F.headRoll += 0.06 * wave(t, 2.3, 0.25) * e; },
  stretch: ({ t, p, e, F, face }) => {
    const bow = smooth(0.05, 0.3, p) * (1 - smooth(0.5, 0.65, p)), back = smooth(0.6, 0.72, p) * (1 - smooth(0.88, 1, p));
    F.hipsPitch += 0.42 * bow - 0.16 * back; F.hipsY -= 0.08 * bow; F.flA -= 1.1 * bow; F.frA -= 1.1 * bow; F.flB += 0.3 * bow; F.frB += 0.3 * bow;
    F.neckPitch -= 0.25 * bow; F.headPitch -= 0.2 * bow; F.tailUp -= 0.3 * bow; F.blA += 0.7 * back; F.brA += 0.7 * back;
    F.jaw += 0.55 * bow * smooth(0.15, 0.3, p); if (bow > 0.5) face.eyes = 'closed';
  },
  happy: ({ t, e, F, face, S }) => {
    const hop = Math.abs(wave(t, 1.5)); F.hipsY += 0.14 * hop * e; F.hipsPitch -= 0.08 * hop * e;
    for (const leg of ['fl', 'fr']) { F[`${leg}A`] -= 0.35 * hop * e; F[`${leg}B`] += 0.4 * hop * e; }
    for (const leg of ['bl', 'br']) F[`${leg}B`] += 0.3 * hop * e;
    S.wagAmp += 0.4; S.wagFreq += 2.5; S.jaw += 0.25; S.tongue += 0.5; face.eyes = 'happy';
  },
  sleep: ({ face }) => { face.eyes = 'closed'; face.zzz = true; },
  wag_tail: ({ t, e, S, F, face }) => { S.wagAmp += 0.55; S.wagFreq += 3; F.hipsYaw += 0.06 * wave(t, 1.6) * e; F.hipsRoll += 0.05 * wave(t, 1.6) * e; face.eyes = 'happy'; S.jaw += 0.2; S.tongue += 0.4; },
  sit: ({ t, e, F }) => { F.headRoll += 0.12 * smooth(0.6, 1.2, t) * e; },
  lie_down: () => {},
  shake_paw: ({ t, p, e, F, face }) => {
    const reach = smooth(0.12, 0.3, p) * (1 - smooth(0.82, 0.95, p));
    F.frA -= 1.2 * reach; F.frB -= 0.2 * reach; F.frA += 0.12 * wave(t, 2.4) * smooth(0.35, 0.45, p) * (1 - smooth(0.7, 0.8, p)); F.headRoll -= 0.15 * e;
    if (p > 0.7) face.right = 'happy';
  },
  roll_over: ({ p, F, face }) => {
    const turn = ease(smooth(0.15, 0.85, p));
    F.hipsRoll += turn * Math.PI * 2; F.hipsY += 0.12 * Math.sin(turn * Math.PI);
    for (const leg of ['fl', 'fr', 'bl', 'br']) F[`${leg}B`] += 0.5 * Math.sin(turn * Math.PI);
    face.eyes = 'happy';
  },
  spin: ({ t, p, e, F, S }) => {
    F.spinYaw += Math.PI * 2 * ease(p);
    const gait = wave(t, 4);
    F.flA += 0.4 * gait * e; F.brA += 0.4 * gait * e; F.frA -= 0.4 * gait * e; F.blA -= 0.4 * gait * e; F.hipsY += 0.03 * Math.abs(gait) * e;
    S.wagAmp += 0.4; S.wagFreq += 2;
  },
  beg: ({ t, e, F, S, face }) => {
    F.hipsPitch -= 0.55 * e; F.hipsY += 0.06 * e; F.neckPitch += 0.25 * e; F.headPitch += 0.2 * e;
    F.flA -= (1.05 + 0.18 * wave(t, 2.6)) * e; F.frA -= (1.05 + 0.18 * wave(t, 2.6, 0.5)) * e; F.flB += 0.9 * e; F.frB += 0.9 * e;
    S.jaw += 0.2; S.tongue += 0.4; face.eyes = 'happy';
  },
  bark: ({ t, e, F, face }) => {
    const pulse = Math.max(0, wave(t, 2.6)); F.jaw += 0.55 * pulse * e; F.headPitch -= 0.14 * pulse * e; F.hipsY += 0.03 * pulse * e;
    F.flA -= 0.15 * pulse * e; F.frA -= 0.15 * pulse * e; face.bark = pulse > 0.8; face.eyes = 'open';
  },
  pet_head: ({ t, e, F, S, face }) => {
    F.headPitch += 0.12 * e; F.headRoll += 0.16 * wave(t, 0.7) * e; F.earL -= 0.35 * e; F.earR -= 0.35 * e;
    S.wagAmp += 0.5; S.wagFreq += 2; face.eyes = 'happy'; face.hearts = true; S.tongue += 0.4; S.jaw += 0.15;
  },
  poke: ({ p, e, F, face }) => {
    const jolt = Math.sin(Math.min(1, p * 2.5) * Math.PI);
    F.hipsZ -= 0.08 * jolt; F.hipsY += 0.06 * jolt; F.earL += 0.5 * jolt; F.earR += 0.5 * jolt; F.headPitch -= 0.15 * jolt * e;
    face.eyes = 'surprised'; face.bang = p < 0.2;
  },
  tickle: ({ t, e, F, S, face }) => {
    F.hipsRoll += 0.2 * wave(t, 3.2) * e; F.headRoll += 0.2 * wave(t, 3.2, 0.3) * e; F.hipsY += 0.04 * Math.abs(wave(t, 3.2)) * e;
    S.jaw += 0.45; S.tongue += 0.6; S.wagAmp += 0.6; S.wagFreq += 3; face.eyes = 'happy'; face.notes = true;
  },
  eat: ({ t, e, F, face }) => {
    F.neckPitch += 0.62 * e; F.headPitch += 0.42 * e; F.hipsPitch += 0.05 * e;
    F.jaw += (0.12 + 0.18 * Math.max(0, wave(t, 3.2))) * e * smooth(0.5, 0.7, t); face.eyes = 'happy'; face.crumbs = true;
  },
  drink: ({ t, e, F, S, face }) => {
    F.neckPitch += 0.62 * e; F.headPitch += 0.42 * e; F.jaw += 0.15 * e;
    S.tongue += 0.6 + 0.4 * Math.max(0, wave(t, 3.5)); face.eyes = 'happy';
  },
  sniff: ({ t, e, F, face }) => {
    F.neckPitch += 0.35 * e; F.headPitch += 0.25 * e; F.headYaw += 0.4 * wave(t, 0.45) * e; F.headPitch += 0.03 * wave(t, 7) * e; face.eyes = 'open';
  },
  look_around: ({ t, e, F, face }) => {
    // 张望：左看、停顿、右看，带歪头。
    const yaw = t < 0.8 ? smooth(0, 0.6, t) * 0.65 : t < 1.5 ? 0.65 - smooth(0.8, 1.4, t) * 1.3 : -0.65 + smooth(1.5, 2.1, t) * 0.65;
    F.headYaw += yaw * e; F.headRoll += -yaw * 0.25 * e; F.earL += 0.2 * e; F.earR += 0.2 * e; face.lookWeight = 0.15; face.eyes = 'open';
  },
  scratch: ({ t, e, F, face }) => {
    F.brA -= (0.95 + 0.22 * wave(t, 6)) * e; F.brB += 0.4 * e; F.brZ += 0.25 * e; F.headRoll += 0.32 * e; F.headYaw += 0.2 * e; F.hipsRoll -= 0.1 * e; face.eyes = 'happy';
  },
  yawn: ({ p, F, face }) => {
    const open = Math.sin(Math.min(1, p * 1.15) * Math.PI);
    F.jaw += 0.65 * open; F.headPitch -= 0.25 * open; F.earL -= 0.2 * open; F.earR -= 0.2 * open; face.eyes = open > 0.25 ? 'closed' : 'sleepy';
  },
  wake_up: ({ t, p, F, face }) => {
    const shake = Math.sin(t * 22) * (1 - p) * smooth(0, 0.2, p);
    F.hipsRoll += 0.18 * shake; F.headRoll += 0.3 * shake; F.headYaw += 0.15 * shake; face.eyes = p < 0.3 ? 'sleepy' : 'open';
  },
  walk: () => {},
  fetch: () => {},
};

/** 二阶弹簧：耳朵、尾巴等次级运动。 */
class Spring {
  constructor(stiffness = 140, damping = 10) { this.k = stiffness; this.c = damping; this.x = 0; this.v = 0; }
  step(target, dt, force = 0) {
    const a = -this.k * (this.x - target) - this.c * this.v + force;
    this.v += a * dt; this.x += this.v * dt; return this.x;
  }
}

const tmpEuler = new THREE.Euler(), tmpQuat = new THREE.Quaternion(), tmpAxis = new THREE.Quaternion(), tmpVec = new THREE.Vector3(), tmpOffset = new THREE.Vector3();
/**
 * 旋转按模型坐标轴给出（x 前倾、y 转向、z 侧倾），围绕关节作用。
 * 骨骼本地轴向各不相同，用 rest 时的朝向 W 换算：local = rest · W⁻¹ · E · W。
 */
function pose(node, x = 0, y = 0, z = 0, offset) {
  const data = node?.userData;
  if (!data?.restQuaternion) return;
  tmpQuat.setFromEuler(tmpEuler.set(x, y, z, 'YXZ'));
  if (data.axis) tmpQuat.premultiply(tmpAxis.copy(data.axis).invert()).multiply(data.axis);
  node.quaternion.copy(data.restQuaternion).multiply(tmpQuat);
  node.position.copy(data.restPosition);
  if (offset) node.position.add(data.parentAxis ? tmpOffset.copy(offset).applyQuaternion(tmpAxis.copy(data.parentAxis).invert()) : offset);
}

export class DogAnimator {
  constructor(rig, { random = Math.random } = {}) {
    this.rig = rig; this.random = random;
    this.current = { ...zero(), ...POSTURE_POSES.stand };
    this.position = new THREE.Vector2(0, 0); this.yaw = 0; this.idleYaw = 0;
    this.target = null; this.speed = 0.9; this.walkPhase = 0; this.walking = 0;
    this.tailPhase = 0; this.time = 0;
    this.ears = [new Spring(120, 9), new Spring(120, 9)];
    this.lastHead = { y: 0, roll: 0, yaw: 0 };
    this.look = { yaw: 0, pitch: 0 };
    this.nextBlink = 2; this.blinkStart = -1;
    this.lastFace = {};
  }

  setHome(x, z, yaw) { this.home = { x, z, yaw }; this.position.set(x, z); this.yaw = yaw; this.idleYaw = yaw; }
  /** 停下后缓慢转向的朝向（如回家后重新面向主人）。 */
  face(yaw) { this.idleYaw = yaw; }

  /** 走/跑到目标点；arrive 回调在到达后调用一次。 */
  moveTo(x, z, { speed = 0.9, arrive, faceYaw } = {}) { this.target = { x, z, arrive, faceYaw }; this.speed = speed; }
  stop() { this.target = null; }
  get moving() { return Boolean(this.target); }

  /** 世界坐标转换到狗的局部坐标（只考虑位置和朝向）。 */
  toLocal(point, out = new THREE.Vector3()) {
    const dx = point.x - this.position.x, dz = point.z - this.position.y;
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    return out.set(dx * c + dz * s, point.y, -dx * s + dz * c);
  }

  update(dt, snapshot, { lookTarget, stroking = false } = {}) {
    dt = Math.min(dt, 0.05); this.time += dt;
    const t = this.time, { action, posture, emotion } = snapshot;
    const style = EMOTION_STYLE[emotion?.name] || EMOTION_STYLE.neutral;
    const S = { ...zero(), ...POSTURE_POSES[posture] }; // 平滑层目标
    const F = zero(); // 快速叠加层
    const face = { eyes: style.eyes, lookWeight: 1 };
    S.jaw += style.jaw; S.tongue += style.tongue; S.wagAmp += style.wagAmp; S.wagFreq += style.wagFreq;
    S.earL += style.ears || 0; S.earR += style.ears || 0; S.tailUp += style.tailUp || 0; S.headPitch += style.headPitch || 0; S.headRoll += style.headRoll || 0;
    if (style.bounce) F.hipsY += style.bounce * Math.abs(wave(t, 2));
    if (posture === 'sleep') { face.eyes = 'closed'; face.zzz = true; S.jaw = 0; S.tongue = 0; S.wagAmp = 0.03; }
    if (posture === 'lie' || posture === 'sleep') face.lookWeight = posture === 'sleep' ? 0 : 0.6;

    if (action && ACTION_LAYERS[action.name]) {
      const elapsed = action.elapsed / 1000, duration = action.duration_ms / 1000;
      ACTION_LAYERS[action.name]({ t: elapsed, p: action.progress, e: envelope(elapsed, duration), S, F, face });
      if (['eat', 'drink', 'sniff', 'scratch', 'roll_over', 'yawn'].includes(action.name)) face.lookWeight = Math.min(face.lookWeight, 0.1);
    }
    if (stroking) { face.eyes = 'happy'; S.earL -= 0.3; S.earR -= 0.3; S.headPitch += 0.08; }

    this.locomote(dt, F);
    // 呼吸：睡着时更慢更深。
    const breath = posture === 'sleep' ? wave(t, 0.28) : wave(t, 0.45);
    F.breath = breath;

    // 平滑层按指数衰减逼近目标，姿态切换约 0.4 秒完成。
    const rate = 1 - Math.exp(-dt * 7);
    for (const key of PARAMS) this.current[key] += (S[key] - this.current[key]) * rate;
    const P = Object.fromEntries(PARAMS.map(key => [key, this.current[key] + F[key]]));

    this.lookAt(dt, P, lookTarget, face.lookWeight);
    this.apply(dt, P, breath);
    this.eyes(dt, face);
    this.lastFace = face;
    return face;
  }

  locomote(dt, F) {
    let moving = false;
    if (this.target) {
      const dx = this.target.x - this.position.x, dz = this.target.z - this.position.y, distance = Math.hypot(dx, dz);
      if (distance < 0.04) {
        const { arrive, faceYaw } = this.target; this.target = null;
        this.idleYaw = faceYaw ?? this.yaw; arrive?.();
      } else {
        const desired = Math.atan2(dx, dz);
        let diff = Math.atan2(Math.sin(desired - this.yaw), Math.cos(desired - this.yaw));
        this.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * 5);
        diff = Math.atan2(Math.sin(desired - this.yaw), Math.cos(desired - this.yaw));
        const step = Math.min(distance, this.speed * dt * Math.max(0, Math.cos(diff)));
        this.position.x += Math.sin(this.yaw) * step; this.position.y += Math.cos(this.yaw) * step;
        moving = true;
      }
    } else {
      const diff = Math.atan2(Math.sin(this.idleYaw - this.yaw), Math.cos(this.idleYaw - this.yaw));
      this.yaw += diff * (1 - Math.exp(-dt * 4));
    }
    this.walking += ((moving ? 1 : 0) - this.walking) * (1 - Math.exp(-dt * 10));
    if (this.walking > 0.01) {
      this.walkPhase += dt * (this.speed > 1.2 ? 9 : 6.5);
      const g = Math.sin(this.walkPhase), w = this.walking, lift = Math.max(0, Math.cos(this.walkPhase)), lift2 = Math.max(0, -Math.cos(this.walkPhase));
      F.flA += 0.5 * g * w; F.brA += 0.5 * g * w; F.frA -= 0.5 * g * w; F.blA -= 0.5 * g * w;
      F.flB += 0.5 * lift * w; F.brB += 0.5 * lift * w; F.frB += 0.5 * lift2 * w; F.blB += 0.5 * lift2 * w;
      F.hipsY += 0.035 * Math.abs(g) * w; F.hipsRoll += 0.04 * g * w; F.headPitch -= 0.04 * Math.abs(g) * w;
      F.wagAmp += 0.2 * w;
    }
  }

  /** 注视：头部转向目标，分配到脖子和头，瞳孔补足剩余角度。 */
  lookAt(dt, P, target, weight = 1) {
    let yaw = 0, pitch = 0;
    if (target && weight > 0) {
      const local = this.toLocal(target, tmpVec);
      const dx = local.x, dz = local.z - 0.4, dy = local.y - 1.25;
      yaw = Math.max(-0.95, Math.min(0.95, Math.atan2(dx, Math.max(0.2, dz)))) * weight;
      pitch = Math.max(-0.4, Math.min(0.35, -Math.atan2(dy, Math.hypot(dx, dz)))) * weight;
      // 目标在身后时不硬扭头。
      if (dz < -0.2) { yaw *= 0.4; pitch *= 0.4; }
    }
    const rate = 1 - Math.exp(-dt * 5);
    this.look.yaw += (yaw - this.look.yaw) * rate; this.look.pitch += (pitch - this.look.pitch) * rate;
    P.neckYaw += this.look.yaw * 0.35; P.headYaw += this.look.yaw * 0.65; P.headPitch += this.look.pitch * 0.7; P.neckPitch += this.look.pitch * 0.3;
    this.pupil = { x: Math.max(-1, Math.min(1, (yaw - this.look.yaw) * 2.5 + yaw * 0.25)), y: Math.max(-1, Math.min(1, (pitch - this.look.pitch) * 2.5 + pitch * 0.3)) };
  }

  apply(dt, P, breath) {
    const r = this.rig;
    r.root.position.set(this.position.x, 0, this.position.y);
    r.root.rotation.set(0, this.yaw + P.spinYaw, 0);
    pose(r.hips, P.hipsPitch, P.hipsYaw, P.hipsRoll, tmpVec.set(0, P.hipsY + breath * 0.006, P.hipsZ));
    pose(r.chest, P.chestPitch + breath * 0.015, 0, 0);
    r.chest.scale.setScalar(1 + breath * 0.012);
    pose(r.neck, P.neckPitch, P.neckYaw, 0);
    pose(r.head, P.headPitch, P.headYaw, P.headRoll);
    pose(r.jaw, Math.max(0, P.jaw) * 0.75, 0, 0);
    const tongue = Math.max(0, Math.min(1.2, P.tongue));
    pose(r.tongue, 0.35 * tongue, 0, 0, tmpVec.set(0, -0.012 * tongue, 0.06 * tongue));
    r.tongue.visible = tongue > 0.05;
    for (const key of ['fl', 'fr', 'bl', 'br']) {
      const [upper, lower] = r.legs[key];
      pose(upper, P[`${key}A`], 0, P[`${key}Z`]);
      pose(lower, P[`${key}B`], 0, 0);
    }
    // 耳朵弹簧：头部上下颠簸和左右转动带动耳朵甩动。
    const head = { y: P.hipsY + P.headPitch * 0.3, roll: P.headRoll + P.hipsRoll, yaw: P.headYaw + P.spinYaw };
    const vy = (head.y - this.lastHead.y) / Math.max(dt, 1e-3), vroll = (head.roll - this.lastHead.roll) / Math.max(dt, 1e-3), vyaw = (head.yaw - this.lastHead.yaw) / Math.max(dt, 1e-3);
    this.lastHead = head;
    [['earL', -1, 0], ['earR', 1, 1]].forEach(([key, side, index]) => {
      const angle = this.ears[index].step(P[key], dt, (vy * 6 + vroll * side * 4 - vyaw * 3) * 1.0);
      pose(r[key], 0, -side * angle * 0.3, side * Math.max(-0.6, Math.min(1.1, angle)));
    });
    // 尾巴：多节相位差形成甩动。
    this.tailPhase += dt * Math.max(0.3, P.wagFreq) * Math.PI * 2;
    r.tail.forEach((segment, index) => {
      const sway = Math.sin(this.tailPhase - index * 0.7) * Math.max(0, P.wagAmp) * (0.6 + index * 0.25);
      // tailUp 为下垂量：正值让尾巴垂下（坐、趴、难过），负值翘起。
      pose(segment, -P.tailUp * (index === 0 ? 0.55 : 0.2), sway, 0);
    });
  }

  eyes(dt, face) {
    const t = this.time;
    if (t >= this.nextBlink || face.blink) {
      if (this.blinkStart < 0 || t - this.blinkStart > 0.18) this.blinkStart = t;
      this.nextBlink = t + 2.4 + this.random() * 3.6 + (this.random() < 0.15 ? -2.2 : 0);
    }
    const blinkT = t - this.blinkStart;
    const open = this.blinkStart >= 0 && blinkT < 0.16 ? Math.abs(Math.cos(blinkT / 0.16 * Math.PI)) : 1;
    const pupil = this.pupil || { x: 0, y: 0 };
    for (const [key, eye] of Object.entries(this.rig.eyes)) {
      const expression = face[key] || face.eyes || 'open';
      eye.draw({ expression, open: ['open', 'surprised', 'sad', 'sleepy'].includes(expression) ? open : 1, lookX: pupil.x, lookY: pupil.y });
    }
  }
}
