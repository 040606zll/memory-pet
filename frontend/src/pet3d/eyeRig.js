import * as THREE from 'three';

/**
 * 真实三维眼睛（贴图模型用）：眼球是 GLB 里独立的球体（tools/blender/rig_tripo_dog.py 生成），
 * 看向时整颗眼球转动；眼睑是包在眼球外的半球壳，绕眼睛横轴转下来盖住眼球；
 * 反光点固定在眼窝里，不随眼球转动。接口与 EyeTexture 相同：draw({ expression, open, lookX, lookY })。
 *
 * 眼睑几何：半球壳的极点在静止时朝后（整个壳藏在脸后），绕 X 轴转 α 后极点转向上方/前方。
 * 上眼睑 α>0、下眼睑 α<0；两个眼睑的边缘都经过眼球左右两端，从正面看，
 * 上眼睑边缘是 ∩ 形、最前端高度 R·cos α，下眼睑同理，组合出眨眼、笑眼、困倦等形状。
 */

const LOOK_YAW = 0.32;
const LOOK_PITCH = 0.26;
const LID_SCALE = [1.06, 1.055];
const DEG = Math.PI / 180;

/** 各表情的眼睑目标角度（度）：upper 上眼睑、lower 下眼睑、tilt 让内眼角一侧更低。 */
const LID_POSES = {
  open: { upper: 0, lower: 0, tilt: 0 },
  surprised: { upper: 0, lower: 0, tilt: 0 },
  heart: { upper: 8, lower: 0, tilt: 0 },
  happy: { upper: 32, lower: 112, tilt: 0 },
  closed: { upper: 104, lower: 76, tilt: 0 },
  sleepy: { upper: 74, lower: 12, tilt: 0 },
  sad: { upper: 52, lower: 0, tilt: 16 },
};
/** 眨眼闭合时两眼睑在眼心略下方相合。 */
const BLINK = { upper: 104, lower: 76 };

function lidTexture() {
  // 半球壳 UV：v=1 在极点、v=0 在边缘。边缘一圈深色睑缘，往里渐变到原色。
  const canvas = document.createElement('canvas');
  canvas.width = 4; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 128, 0, 0);
  gradient.addColorStop(0, '#2a2b30'); gradient.addColorStop(0.06, '#3a3a40');
  gradient.addColorStop(0.16, '#d8d8d8'); gradient.addColorStop(0.4, '#ffffff'); gradient.addColorStop(1, '#ffffff');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 4, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function catchlightTexture() {
  const size = 64, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.62, 'rgba(255,255,255,0.95)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class EyeRig {
  /** ball：GLB 中的眼球网格（原点在球心）；side：-1 左眼、1 右眼。 */
  constructor(ball, side) {
    this.ball = ball;
    this.side = side;
    this.radius = ball.userData.radius || ball.geometry.boundingSphere?.radius || 0.14;
    this.restQuaternion = ball.quaternion.clone();
    this.state = { upper: 0, lower: 0, tilt: 0 };
    this.expression = 'open';
    this.key = '';
    this.disposables = [];

    // 眼球贴图复制到画布上，爱心表情直接画在瞳孔位置。
    const source = ball.material.map?.image;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = source?.width || 1024;
    this.ctx = this.canvas.getContext('2d');
    this.source = source;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.anisotropy = 4;
    this.paint(false);
    this.originalMaterial = ball.material;
    // 湿润的眼球：清漆层给出随光线移动的真实高光。
    ball.material = new THREE.MeshPhysicalMaterial({ map: this.texture, roughness: 0.42, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2 });
    ball.castShadow = false; ball.receiveShadow = true;

    // 眼窝：与眼球同位置、同静止朝向，眼睑和反光点挂在这里，不随眼球转动。
    this.socket = new THREE.Group();
    this.socket.name = `${ball.name}-socket`;
    this.socket.position.copy(ball.position);
    this.socket.quaternion.copy(ball.quaternion);
    ball.parent.add(this.socket);

    const lidColor = new THREE.Color(ball.userData.lid_color || '#555255');
    const rim = lidTexture();
    this.disposables.push(rim);
    this.lids = LID_SCALE.map((scale, index) => {
      const geometry = new THREE.SphereGeometry(this.radius * scale, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      geometry.rotateX(-Math.PI / 2); // 极点朝后（-Z），整个壳在眼球中心平面之后
      const material = new THREE.MeshStandardMaterial({ color: lidColor, map: rim, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
      const lid = new THREE.Mesh(geometry, material);
      lid.name = index === 0 ? 'eyelid-upper' : 'eyelid-lower';
      lid.castShadow = true; lid.receiveShadow = true;
      lid.visible = false;
      this.socket.add(lid);
      this.disposables.push(geometry, material);
      return lid;
    });

    // 固定反光点：大的在上方靠鼻梁一侧，小的在下方外侧（与原模型画的高光位置一致）。
    const glint = catchlightTexture();
    this.disposables.push(glint);
    const nose = -side;
    for (const [direction, size, opacity] of [[[0.36 * nose, 0.5, 1], 0.2, 0.95], [[-0.3 * nose, -0.42, 1], 0.085, 0.8]]) {
      const normal = new THREE.Vector3(...direction).normalize();
      const geometry = new THREE.CircleGeometry(this.radius * size, 24);
      const material = new THREE.MeshBasicMaterial({ map: glint, transparent: true, opacity, depthWrite: false, toneMapped: false });
      const spot = new THREE.Mesh(geometry, material);
      spot.name = 'eye-catchlight';
      spot.position.copy(normal).multiplyScalar(this.radius * 1.012);
      spot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      spot.renderOrder = 2;
      this.socket.add(spot);
      this.disposables.push(geometry, material);
    }
  }

  paint(heart) {
    const ctx = this.ctx, S = this.canvas.width;
    if (this.source) ctx.drawImage(this.source, 0, 0, S, S);
    else { ctx.fillStyle = '#05080c'; ctx.fillRect(0, 0, S, S); }
    if (heart) {
      // 瞳孔中心按眼球贴图实测（右眼偏画布左、左眼偏右）。
      const x = S * (0.5 - 0.05 * this.side), y = S * 0.49, r = S * 0.17;
      const fill = ctx.createLinearGradient(x, y - r, x, y + r);
      fill.addColorStop(0, '#ff9cc4'); fill.addColorStop(1, '#ff4f8f');
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.moveTo(x, y + r * 0.95);
      ctx.bezierCurveTo(x - r * 1.5, y - r * 0.1, x - r * 0.75, y - r * 1.25, x, y - r * 0.45);
      ctx.bezierCurveTo(x + r * 0.75, y - r * 1.25, x + r * 1.5, y - r * 0.1, x, y + r * 0.95); ctx.fill();
    }
    this.texture.needsUpdate = true;
  }

  draw({ expression = 'open', open = 1, lookX = 0, lookY = 0 }) {
    const target = LID_POSES[expression] || LID_POSES.open;
    // 表情之间平滑过渡；眨眼本身已由动画层给出时间曲线，直接叠加。
    const s = this.state, k = 0.3;
    s.upper += (target.upper - s.upper) * k;
    s.lower += (target.lower - s.lower) * k;
    s.tilt += (target.tilt - s.tilt) * k;
    const blink = 1 - Math.max(0, Math.min(1, open));
    const upper = Math.max(s.upper, BLINK.upper * blink);
    const lower = Math.max(s.lower, BLINK.lower * blink);
    this.setLid(this.lids[0], upper, s.tilt);
    this.setLid(this.lids[1], -lower, -s.tilt * 0.4);

    if ((expression === 'heart') !== (this.expression === 'heart')) this.paint(expression === 'heart');
    this.expression = expression;

    const look = expression === 'closed' ? 0 : 1;
    tmpEuler.set(lookY * LOOK_PITCH * look, lookX * LOOK_YAW * look, 0, 'YXZ');
    this.ball.quaternion.copy(this.restQuaternion).multiply(tmpQuat.setFromEuler(tmpEuler));
  }

  setLid(lid, degrees, tiltDegrees) {
    lid.visible = Math.abs(degrees) > 1.5;
    if (!lid.visible) return;
    // 先绕前后轴倾斜（内眼角一侧更低），再绕横轴合上。
    tmpQuat.setFromAxisAngle(AXIS_Z, tiltDegrees * this.side * DEG);
    lid.quaternion.copy(tmpQuat).multiply(tmpQuat2.setFromAxisAngle(AXIS_X, degrees * DEG));
  }

  dispose() {
    this.socket.removeFromParent();
    this.disposables.forEach(item => item.dispose());
    this.texture.dispose();
    this.ball.material.dispose();
  }
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const tmpQuat = new THREE.Quaternion();
const tmpQuat2 = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
