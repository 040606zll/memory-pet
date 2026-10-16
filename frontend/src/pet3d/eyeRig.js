import * as THREE from 'three';

/**
 * 真实三维眼睛（贴图模型用）：眼球是 GLB 里独立的球体（tools/blender/rig_tripo_dog.py 生成），
 * 看向时整颗眼球转动；反光点固定在眼窝里，不随眼球转动。接口与 EyeTexture 相同：draw({ expression, open, lookX, lookY })。
 *
 * 眼睑：一片只覆盖眼眶开口的薄球冠（半径略大于眼球，范围取 GLB extras.opening），
 * 由着色器决定哪部分可见。以眼轴为前方、向上为上，球冠上一点的"仰角" e = atan2(y, z)：
 * 上眼睑盖住 e > upper 的部分，下眼睑盖住 e < lower 的部分。边界是经过眼角两端的大圆，
 * 正面看上眼睑边缘呈 ∩、下眼睑抬过眼心后也呈 ∩（笑眼）；两者在眼心略下方相合即闭眼。
 * 眼睑永远不超出眼眶，不会像整颗球壳那样鼓出脸外。
 */

const LOOK_YAW = 0.32;
const LOOK_PITCH = 0.26;
const DEG = Math.PI / 180;
const OPEN_UPPER = 90;
const OPEN_LOWER = -90;

/** 各表情眼睑边缘的仰角（度）：upper 以上被上眼睑盖住，lower 以下被下眼睑盖住；tilt 让内眼角一侧更低。 */
const LID_POSES = {
  open: { upper: OPEN_UPPER, lower: OPEN_LOWER, tilt: 0 },
  surprised: { upper: OPEN_UPPER, lower: OPEN_LOWER, tilt: 0 },
  heart: { upper: 48, lower: OPEN_LOWER, tilt: 0 },
  happy: { upper: 62, lower: 16, tilt: 0 },
  closed: { upper: -12, lower: -12, tilt: 0 },
  sleepy: { upper: 6, lower: -48, tilt: 0 },
  sad: { upper: 26, lower: OPEN_LOWER, tilt: 18 },
};
/** 眨眼闭合位置：两眼睑在眼心略下方相合。 */
const BLINK = -12;

function lidMaterial(color) {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 });
  material.userData.uniforms = { uUpper: { value: OPEN_UPPER * DEG }, uLower: { value: OPEN_LOWER * DEG }, uTilt: { value: 0 } };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, material.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLidDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLidDir = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLidDir;\nuniform float uUpper;\nuniform float uLower;\nuniform float uTilt;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 lidDir = normalize(vLidDir);
        float tiltedY = lidDir.y * cos(uTilt) + lidDir.x * sin(uTilt);
        float upperEdge = atan(tiltedY, lidDir.z) - uUpper;
        float lowerEdge = uLower - atan(lidDir.y, lidDir.z);
        if (upperEdge < 0.0 && lowerEdge < 0.0) discard;
        // 睑缘：边缘一窄条深色，再往里一点略暗，像有厚度的眼睑边。
        float edge = max(upperEdge, lowerEdge);
        diffuseColor.rgb *= mix(0.22, 1.0, smoothstep(0.015, 0.06, edge)) * mix(0.85, 1.0, smoothstep(0.06, 0.2, edge));`);
  };
  return material;
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
    this.state = { upper: OPEN_UPPER, lower: OPEN_LOWER, tilt: 0 };
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

    // 眼睑球冠：几何在"眼睑坐标"里建（+Z 为眼眶开口方向，+Y 朝上），再整体转到眼窝坐标。
    const openingAxis = new THREE.Vector3(...(ball.userData.opening_axis || ball.userData.axis || [0, 0, 1])).normalize();
    const lidUp = new THREE.Vector3(0, 1, 0).addScaledVector(openingAxis, -openingAxis.y).normalize();
    const lidRight = new THREE.Vector3().crossVectors(lidUp, openingAxis).normalize();
    const reach = Math.min(85, (ball.userData.opening || 60) + 5) * DEG;
    const geometry = new THREE.SphereGeometry(this.radius * 1.025, 72, 28, 0, Math.PI * 2, 0, reach);
    geometry.rotateX(Math.PI / 2); // 极点 +Y → +Z
    this.lidMaterial = lidMaterial(new THREE.Color(ball.userData.lid_color || '#555255'));
    this.lid = new THREE.Mesh(geometry, this.lidMaterial);
    this.lid.name = 'eyelid';
    this.lid.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(lidRight, lidUp, openingAxis));
    this.lid.castShadow = false; this.lid.receiveShadow = true;
    this.lid.visible = false;
    this.socket.add(this.lid);
    this.disposables.push(geometry, this.lidMaterial);

    // 固定反光点：沿眼睛实际朝向（GLB extras.axis），大的偏上方靠鼻梁一侧，小的在下方外侧，
    // 都落在瞳孔范围内，与原模型画的高光位置一致；不随眼球转动。
    const glint = catchlightTexture();
    this.disposables.push(glint);
    const axis = new THREE.Vector3(...(ball.userData.axis || [0, 0, 1])).normalize();
    const nose = new THREE.Vector3(-side, 0, 0);
    const up = new THREE.Vector3(0, 1, 0);
    for (const [upward, inward, size, opacity] of [[0.42, 0.26, 0.17, 0.95], [-0.3, -0.22, 0.075, 0.8]]) {
      const normal = axis.clone().addScaledVector(up, upward).addScaledVector(nose, inward).normalize();
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
    // 眨眼：上眼睑从当前位置落到相合线，下眼睑从当前位置升到相合线。
    const upper = s.upper + (BLINK - s.upper) * blink;
    const lower = s.lower + (BLINK - s.lower) * blink;
    const uniforms = this.lidMaterial.userData.uniforms;
    uniforms.uUpper.value = upper * DEG;
    uniforms.uLower.value = lower * DEG;
    // 内眼角（靠鼻梁一侧）更低：左眼鼻梁在 +X。
    uniforms.uTilt.value = s.tilt * DEG * -this.side;
    this.lid.visible = upper < OPEN_UPPER - 25 || lower > OPEN_LOWER + 25;

    if ((expression === 'heart') !== (this.expression === 'heart')) this.paint(expression === 'heart');
    this.expression = expression;

    const look = expression === 'closed' ? 0 : 1;
    tmpEuler.set(lookY * LOOK_PITCH * look, lookX * LOOK_YAW * look, 0, 'YXZ');
    this.ball.quaternion.copy(this.restQuaternion).multiply(tmpQuat.setFromEuler(tmpEuler));
  }

  dispose() {
    this.socket.removeFromParent();
    this.disposables.forEach(item => item.dispose());
    this.texture.dispose();
    this.ball.material.dispose();
  }
}

const tmpQuat = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
