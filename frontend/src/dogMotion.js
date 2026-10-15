/** 原型纹理的位置与动作时长；保持原图坐标，禁止为动作换角色图片。 */
export const DOG = {
  src: '/assets/robot-dog-reference.png',
  mask: '/assets/robot-dog-cutout.png',
  maskBounds: { x: 254, y: 308, width: 509, height: 557 },
  subjectBounds: { x: 121, y: 137, width: 234, height: 257 },
  reference: { width: 706, height: 500 },
  crop: { x: 112, y: 128, width: 250, height: 272 },
  durations: { idle: 4000, blink: 800, wave: 2200, nod: 1600, shake_head: 1900, stretch: 3200, happy: 2400, sleep: 4800, wag_tail: 2200 },
};
export const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
const empty = () => ({ head: 0, headY: 0, body: 0, paw: 0, tail: 0, ear: 0, blink: 0 });

/** 所有姿态共用连续时间，切换从已显示的姿态过渡，避免打断动作时跳回首帧。 */
export class DogMotion {
  constructor() { this.key = null; this.pose = empty(); this.from = empty(); this.changed = 0; }
  /** 暂停后重新建立过渡起点，保留冻结姿态，避免同名闲置动作直接跳到新的时间相位。 */
  resume() { this.key = null; }
  sample(state, time) {
    const key = `${state.name}:${state.started ?? 'idle'}`;
    if (key !== this.key) { this.from = { ...this.pose }; this.key = key; this.changed = time; }
    const seconds = time / 1000, p = state.progress || 0;
    const envelope = Math.sin(Math.PI * p) ** 2;
    const phase = (time % 5300) / 5300;
    const naturalBlink = phase < .048 ? Math.sin(Math.PI * phase / .048) ** 4 : 0;
    const target = {
      head: .006 * Math.sin(seconds * .8), headY: .45 * Math.sin(seconds * 1.5),
      body: .65 * Math.sin(seconds * 1.65), paw: 0,
      tail: .055 * Math.sin(seconds * 2.5), ear: .016 * Math.sin(seconds * 1.1), blink: naturalBlink,
    };
    switch (state.name) {
      case 'blink': target.blink = Math.max(target.blink, Math.sin(Math.PI * p) ** 6); break;
      case 'wave': target.paw = -.42 * envelope * (.65 + .35 * Math.sin(p * Math.PI * 8)); target.head += .035 * envelope; break;
      case 'nod': target.headY += 5 * Math.sin(p * Math.PI * 4) * envelope; target.head += .025 * Math.sin(p * Math.PI * 4) * envelope; break;
      case 'shake_head': target.head += .085 * Math.sin(p * Math.PI * 6) * envelope; break;
      case 'stretch': target.headY -= 7 * envelope; target.body += 2.5 * envelope; target.paw -= .09 * envelope; break;
      case 'happy': target.head += .04 * Math.sin(p * Math.PI * 4) * envelope; target.headY -= 2 * envelope; target.tail += .38 * Math.sin(p * Math.PI * 12) * envelope; break;
      case 'sleep': target.blink = Math.max(target.blink, smooth(p / .12) * (1 - smooth((p - .85) / .15))); target.headY += 4 * envelope; break;
      case 'wag_tail': target.tail += .52 * Math.sin(p * Math.PI * 10) * envelope; break;
      default: break;
    }
    const blend = smooth((time - this.changed) / 220);
    for (const name of Object.keys(target)) this.pose[name] = this.from[name] * (1 - blend) + target[name] * blend;
    return { ...this.pose };
  }
}

const weight = (x, y, cx, cy, rx, ry) => smooth(1 - Math.hypot((x - cx) / rx, (y - cy) / ry));
const rotate = (x, y, cx, cy, angle) => [cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle), cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle)];

/** 共用网格顶点，头、耳、尾巴与前爪局部变形不会产生分层接缝。 */
export function deform(x, y, pose) {
  let nx = x, ny = y;
  const headWeight = smooth((285 - y) / 35) * smooth((x - 164) / 25);
  const head = rotate(nx, ny, 253, 274, pose.head * headWeight);
  nx = head[0]; ny = head[1] + pose.headY * headWeight;
  ny += pose.body * weight(x, y, 228, 308, 105, 88);
  const tailWeight = weight(x, y, 150, 245, 32, 55);
  const tail = rotate(nx, ny, 174, 280, pose.tail * tailWeight);
  nx = tail[0]; ny = tail[1];
  const paw = rotate(nx, ny, 204, 315, pose.paw * weight(x, y, 211, 367, 47, 68));
  nx = paw[0]; ny = paw[1];
  const earWeight = weight(x, y, 337, 245, 29, 65) + weight(x, y, 185, 172, 48, 37);
  const ear = rotate(nx, ny, x < 250 ? 234 : 319, x < 250 ? 155 : 194, pose.ear * earWeight);
  return ear;
}
