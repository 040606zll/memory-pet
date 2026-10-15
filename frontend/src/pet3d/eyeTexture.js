import * as THREE from 'three';

/** 发光眼睛：在小画布上绘制表情，状态变化时才重绘并上传纹理。 */
export const EYE_EXPRESSIONS = ['open', 'happy', 'closed', 'heart', 'surprised', 'sad', 'sleepy'];
const SIZE = 192;
const CYAN = '#3ee6f5';

export class EyeTexture {
  constructor(side = 1) {
    this.side = side;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.key = '';
    this.draw({ expression: 'open', open: 1, lookX: 0, lookY: 0 });
  }

  /** open 0~1 为睁眼程度；look 为瞳孔偏移（-1~1）。 */
  draw({ expression = 'open', open = 1, lookX = 0, lookY = 0 }) {
    const key = `${expression}:${Math.round(open * 12)}:${Math.round(lookX * 8)}:${Math.round(lookY * 8)}`;
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx, c = SIZE / 2, r = SIZE / 2;
    ctx.clearRect(0, 0, SIZE, SIZE);
    // 眼球底：深色玻璃。
    const glass = ctx.createRadialGradient(c - 20, c - 25, 10, c, c, r);
    glass.addColorStop(0, '#26364a'); glass.addColorStop(0.86, '#0c1420'); glass.addColorStop(1, 'rgba(12,20,32,0)');
    ctx.fillStyle = glass; ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    // 只在眼球圆内作画，边缘淡出与眼罩融合。
    ctx.beginPath(); ctx.arc(c, c, r * 0.9, 0, Math.PI * 2); ctx.clip();
    ctx.shadowColor = CYAN; ctx.shadowBlur = 18;
    ctx.strokeStyle = CYAN; ctx.fillStyle = CYAN; ctx.lineCap = 'round'; ctx.lineWidth = 15;
    if (expression === 'happy') {
      ctx.beginPath(); ctx.arc(c, c + 22, 42, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    } else if (expression === 'closed') {
      ctx.beginPath(); ctx.arc(c, c - 18, 42, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
    } else if (expression === 'heart') {
      ctx.fillStyle = '#ff7fb0'; ctx.shadowColor = '#ff7fb0';
      ctx.beginPath(); ctx.moveTo(c, c + 46);
      ctx.bezierCurveTo(c - 70, c - 4, c - 34, c - 60, c, c - 22);
      ctx.bezierCurveTo(c + 34, c - 60, c + 70, c - 4, c, c + 46); ctx.fill();
      ctx.fillStyle = '#ffffffcc'; ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(c - 22, c - 18, 8, 0, Math.PI * 2); ctx.fill();
    } else {
      this.iris(expression, lookX, lookY);
      // 眼睑：从上往下盖住，sad 内侧下垂，sleepy 半闭。
      const lid = expression === 'sleepy' ? Math.min(open, 0.45) : open;
      if (lid < 0.999 || expression === 'sad') {
        ctx.shadowBlur = 0; ctx.fillStyle = '#0c1420';
        const drop = (1 - lid) * SIZE * 1.02;
        const tilt = expression === 'sad' ? 26 * this.side : 0;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(SIZE, 0);
        ctx.lineTo(SIZE, drop + tilt); ctx.quadraticCurveTo(c, drop + 18, 0, drop - tilt); ctx.closePath(); ctx.fill();
        if (lid < 0.12) { ctx.shadowBlur = 14; ctx.strokeStyle = CYAN; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(c, c - 30, 50, Math.PI * 0.25, Math.PI * 0.75); ctx.stroke(); }
      }
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** 与贴图模型的烘焙眼睛一致：青色外环包着大黑瞳，左上大高光、右下小高光。 */
  iris(expression, lookX, lookY) {
    const ctx = this.ctx, c = SIZE / 2;
    const big = expression === 'surprised';
    const ir = big ? 92 : 88, px = c + lookX * 8, py = c + lookY * 7;
    const ring = ctx.createRadialGradient(px, py, ir * 0.6, px, py, ir);
    ring.addColorStop(0, '#0f8fa8'); ring.addColorStop(0.55, '#4fe3f2'); ring.addColorStop(1, '#1a6f86');
    ctx.fillStyle = ring; ctx.beginPath(); ctx.arc(px, py, ir, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    const pupil = ctx.createRadialGradient(px - 12, py - 14, 4, px, py, ir * 0.8);
    pupil.addColorStop(0, '#1c2633'); pupil.addColorStop(1, '#03070c');
    ctx.fillStyle = pupil; ctx.beginPath(); ctx.arc(px + lookX * 4, py + lookY * 4, big ? ir * 0.58 : ir * 0.74, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(px - 24, py - 26, 17, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(px + 26, py + 24, 7, 0, Math.PI * 2); ctx.fill();
  }

  dispose() { this.texture.dispose(); }
}

/** 柔光贴图：用于眼睛光晕、地面阴影与粒子。 */
export function radialTexture(inner = 'rgba(80,230,255,0.9)', outer = 'rgba(80,230,255,0)', size = 128) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, inner); gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 文字/符号贴图：爱心、Zzz、音符等粒子。 */
export function glyphTexture(glyph, color, size = 128) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${size * 0.72}px "PingFang SC", "Noto Sans SC", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.08; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.strokeText(glyph, size / 2, size / 2 + 4);
  ctx.fillStyle = color; ctx.fillText(glyph, size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 项圈吊牌：深色底板上的发光爪印。 */
export function pawTagTexture(size = 128) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'), c = size / 2;
  ctx.fillStyle = '#2b333d'; ctx.beginPath(); ctx.arc(c, c, c, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = CYAN; ctx.shadowBlur = 10; ctx.fillStyle = CYAN;
  ctx.beginPath(); ctx.ellipse(c, c + 14, 22, 18, 0, 0, Math.PI * 2); ctx.fill();
  for (const [x, y] of [[-26, -8], [-10, -26], [10, -26], [26, -8]]) { ctx.beginPath(); ctx.ellipse(c + x, c + y, 9, 11, 0, 0, Math.PI * 2); ctx.fill(); }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
