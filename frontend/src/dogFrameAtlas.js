import { loadDogSprites, SPRITE_DURATIONS } from './dogSpriteAssets.js';

const FPS = 30, WIDTH = 304, HEIGHT = 328, PAD_X = 16, PAD_Y = 20, COLUMNS = 8;
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const envelope = p => ease(p / .22) * ease((1 - p) / .28);

/** 所有动作来自同一套刚性部件。这里只计算角度、位移和眼睛帧，禁止改变部件宽高。 */
export function dogFramePose(name, progress) {
  const p = clamp(progress), amount = envelope(p), pose = { headAngle: 0, headY: 0, tailAngle: 0, pawAngle: 0, pawX: 0, eye: 0 };
  if (p === 0 || p === 1) return pose;
  const close = (start, end) => ease((p - start) / .12) * ease((end - p) / .16);
  if (name === 'blink') pose.eye = close(.08, .72);
  if (name === 'happy') { pose.eye = close(.12, .9); pose.headAngle = -.035 * amount; pose.tailAngle = Math.sin(p * Math.PI * 4) * .12 * amount; }
  if (name === 'nod') { pose.headY = Math.sin(p * Math.PI) * 4 * amount; pose.headAngle = .045 * amount; }
  if (name === 'shake_head') pose.headAngle = Math.sin(p * Math.PI * 4) * .045 * amount;
  if (name === 'wag_tail') pose.tailAngle = Math.sin(p * Math.PI * 4) * .2 * amount;
  if (name === 'wave') pose.pawAngle = (.18 + .035 * Math.sin(p * Math.PI * 4)) * amount;
  if (name === 'stretch') { pose.headY = 4 * amount; pose.headAngle = .04 * amount; pose.pawX = 5 * amount; }
  if (name === 'sleep') { pose.eye = close(.04, .98); pose.headAngle = .04 * amount; pose.headY = 4 * amount; }
  return pose;
}

function paths() {
  const head = new Path2D();
  head.moveTo(12, -8); head.lineTo(284, -8); head.lineTo(284, 190);
  head.bezierCurveTo(255, 188, 236, 179, 221, 158);
  head.bezierCurveTo(202, 168, 188, 178, 165, 176);
  head.bezierCurveTo(118, 173, 81, 154, 62, 126);
  head.bezierCurveTo(47, 116, 35, 103, 21, 87); head.closePath();
  const tail = new Path2D();
  tail.moveTo(13, 104); tail.bezierCurveTo(34, 99, 49, 104, 55, 125);
  tail.bezierCurveTo(58, 139, 65, 149, 65, 172); tail.lineTo(36, 179);
  tail.bezierCurveTo(14, 161, 7, 130, 13, 104); tail.closePath();
  const paw = new Path2D();
  paw.moveTo(88, 185); paw.bezierCurveTo(115, 181, 139, 199, 143, 235);
  paw.bezierCurveTo(156, 254, 160, 280, 140, 288);
  paw.lineTo(97, 288); paw.bezierCurveTo(84, 272, 81, 224, 88, 185); paw.closePath();
  return { head, tail, paw };
}

function part(source, path) {
  const layer = document.createElement('canvas'); layer.width = 272; layer.height = 288;
  const ctx = layer.getContext('2d'); ctx.clip(path); ctx.drawImage(source, 0, 0);
  return layer;
}

function rigid(context, image, x, y, angle = 0, dx = 0, dy = 0) {
  context.save(); context.translate(x + dx, y + dy); context.rotate(angle);
  context.drawImage(image, -x, -y); context.restore();
}

/** 在加载阶段烘焙完整图片帧；播放阶段只裁切一张帧，不叠加两张脸，也没有像素形变。 */
export async function bakeDogFrames(source, signal) {
  const blink = source.manifest.actions.blink, first = blink.frames[0], image = source.images.blink;
  const neutral = document.createElement('canvas'); neutral.width = 272; neutral.height = 288;
  neutral.getContext('2d').drawImage(image, first.x, first.y, first.width, first.height, 0, 0, first.width, first.height);
  const shape = paths(), head = part(neutral, shape.head), tail = part(neutral, shape.tail), paw = part(neutral, shape.paw);
  const body = document.createElement('canvas'); body.width = 272; body.height = 288;
  const bodyContext = body.getContext('2d'); bodyContext.drawImage(neutral, 0, 0);
  bodyContext.globalCompositeOperation = 'destination-out';
  for (const path of Object.values(shape)) bodyContext.fill(path);
  bodyContext.globalCompositeOperation = 'source-over';
  const headContext = head.getContext('2d'), images = {}, actions = {};
  const work = document.createElement('canvas'); work.width = WIDTH; work.height = HEIGHT;
  const context = work.getContext('2d');
  let released = false;
  const release = () => { if (!released) new Set(Object.values(images)).forEach(bitmap => bitmap.close()); released = true; };
  const atlas = document.createElement('canvas'), jobs = [], positions = new Map();
  try {
    for (const [name, duration_ms] of Object.entries(SPRITE_DURATIONS)) {
      if (signal.aborted) throw new DOMException('动画加载已取消', 'AbortError');
      const count = name === 'idle' ? 1 : Math.ceil(duration_ms * FPS / 1000) + 1;
      const frames = [];
      for (let index = 0; index < count; index++) {
        const pose = dogFramePose(name, count === 1 ? 0 : index / (count - 1));
        // 共享相同姿态，避免九个动作重复分配相同的中立帧与闭眼帧。
        for (const [key, step] of Object.entries({ headAngle: .002, headY: .25, tailAngle: .01, pawAngle: .005, pawX: .25, eye: 1 / 6 })) pose[key] = Math.round(pose[key] / step) * step;
        const key = JSON.stringify(pose);
        if (!positions.has(key)) { positions.set(key, jobs.length); jobs.push(pose); }
        const position = positions.get(key);
        frames.push({ x: position % COLUMNS * WIDTH, y: Math.floor(position / COLUMNS) * HEIGHT, width: WIDTH, height: HEIGHT, anchorX: PAD_X + first.anchorX, anchorY: PAD_Y + first.anchorY });
      }
      actions[name] = { duration_ms, fps: FPS, referenceHeight: PAD_Y + first.anchorY, referenceWidth: first.width, frames };
    }
    atlas.width = COLUMNS * WIDTH; atlas.height = Math.ceil(jobs.length / COLUMNS) * HEIGHT;
    const atlasContext = atlas.getContext('2d');
    for (const [index, pose] of jobs.entries()) {
        context.clearRect(0, 0, WIDTH, HEIGHT); context.save(); context.translate(PAD_X, PAD_Y);
          // 原图的躯干只画一次；运动部件相互遮挡，不进行透明度交叉淡化。
          rigid(context, tail, 53, 166, pose.tailAngle); context.drawImage(body, 0, 0);
          // 颈部和肩部的原有纹理在接缝下方留出少量遮挡余量，尺寸保持1:1。
          context.drawImage(neutral, 90, 178, 100, 18, 90, 173, 100, 18);
          context.drawImage(neutral, 99, 193, 28, 32, 99, 188, 28, 32);
          rigid(context, paw, 110, 197, pose.pawAngle, pose.pawX);
          headContext.clearRect(0, 0, 272, 288); headContext.save(); headContext.clip(shape.head); headContext.drawImage(neutral, 0, 0);
          if (pose.eye > 0) {
            // 眼睛使用真实闭合帧；其余头部始终使用同一张纹理，避免生成图跨帧变脸。
            const eyeFrame = blink.frames[Math.round(pose.eye * 6)];
            headContext.beginPath(); headContext.ellipse(126, 81, 24, 25, 0, 0, Math.PI * 2); headContext.clip();
            headContext.drawImage(image, eyeFrame.x, eyeFrame.y, eyeFrame.width, eyeFrame.height, first.anchorX - eyeFrame.anchorX, first.anchorY - eyeFrame.anchorY, eyeFrame.width, eyeFrame.height);
          }
          headContext.restore(); rigid(context, head, 146, 165, pose.headAngle, 0, pose.headY);
        context.restore();
        const x = index % COLUMNS * WIDTH, y = Math.floor(index / COLUMNS) * HEIGHT;
        atlasContext.drawImage(work, x, y);
    }
    const bitmap = await createImageBitmap(atlas);
    for (const name of Object.keys(actions)) images[name] = bitmap;
    if (signal.aborted) throw new DOMException('动画加载已取消', 'AbortError');
    return { manifest: { version: 2, format: 'coherent-rigid-frames', uniqueFrames: jobs.length, decodedBytes: atlas.width * atlas.height * 4, actions }, images, release };
  } catch (error) { release(); throw error; }
  finally { for (const canvas of [neutral, head, tail, paw, body, work, atlas]) canvas.width = canvas.height = 0; }
}

export async function loadCoherentDogSprites(signal) {
  const source = await loadDogSprites(signal, { only: ['blink'] });
  try { return await bakeDogFrames(source, signal); }
  finally { source.release(); }
}
