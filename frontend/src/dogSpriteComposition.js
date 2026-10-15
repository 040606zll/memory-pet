const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** 小动作只替换对应部位，生成帧中不应运动的毛纹、躯干和脚保持同一张中立图。 */
export const MOTION_REGIONS = {
  blink: { x: 120, y: 82, rx: 30, ry: 28 },
  wag_tail: { x: 15, y: 154, rx: 54, ry: 49, protectHead: true },
  wave: { x: 108, y: 202, rx: 72, ry: 87 },
  happy: { x: 143, y: 91, rx: 132, ry: 108 },
  nod: { x: 143, y: 91, rx: 132, ry: 108 },
  shake_head: { x: 143, y: 91, rx: 132, ry: 108 },
};

export function motionWeight(progress) {
  // 起手和收势回到同一中立图，不在动作结束时突然换另一只近似狗。
  return smooth(progress / .16) * smooth((1 - progress) / .2);
}

export function poseGeometry(sample, width, height, neutral = sample.neutral || sample) {
  const frame = sample.frame, base = neutral.frame;
  const unit = Math.min(height * .96 / neutral.referenceHeight, width * .9 / neutral.referenceWidth);
  const scale = unit * neutral.referenceHeight / sample.referenceHeight;
  return { x: width / 2 - frame.anchorX * scale, y: height - frame.anchorY * scale, width: frame.width * scale, height: frame.height * scale, scale, unit };
}

function drawPose(context, sample, width, height, neutral) {
  const frame = sample.frame, target = poseGeometry(sample, width, height, neutral);
  // 只等比绘制真实图片帧，宽高使用同一个比例；没有网格、骨骼或局部拉伸。
  context.drawImage(sample.image, frame.x, frame.y, frame.width, frame.height, target.x, target.y, target.width, target.height);
}

/** 局部帧合成：两个真实帧在活动部位短暂混合，静止区域每个像素都来自固定中立图。 */
export class DogFramePainter {
  constructor({ diagnose = false } = {}) {
    this.pose = document.createElement('canvas'); this.mask = document.createElement('canvas');
    this.poseContext = this.pose.getContext('2d', { willReadFrequently: diagnose }); this.maskContext = this.mask.getContext('2d', { willReadFrequently: diagnose });
    if (!this.poseContext || !this.maskContext) throw new Error('浏览器无法合成宠物动作，请重试。');
  }
  paint(context, sample, width, height) {
    const neutral = sample.neutral || sample;
    drawPose(context, neutral, width, height, neutral);
    if (sample.name === 'idle' || sample.activeWeight === 0) return;
    if (this.pose.width !== width || this.pose.height !== height) {
      this.pose.width = this.mask.width = width; this.pose.height = this.mask.height = height;
    }
    const pose = this.poseContext, mask = this.maskContext;
    pose.clearRect(0, 0, width, height); pose.globalCompositeOperation = 'lighter';
    pose.globalAlpha = 1 - (sample.frameMix || 0); drawPose(pose, sample, width, height, neutral);
    if (sample.nextFrame && sample.frameMix) {
      pose.globalAlpha = sample.frameMix; drawPose(pose, { ...sample, frame: sample.nextFrame }, width, height, neutral);
    }
    pose.globalAlpha = 1; pose.globalCompositeOperation = 'source-over';
    mask.clearRect(0, 0, width, height);
    const region = sample.region, weight = sample.activeWeight ?? 1;
    mask.globalAlpha = weight;
    if (region) {
      const target = poseGeometry(neutral, width, height, neutral), scale = target.scale;
      mask.save(); mask.translate(target.x + region.x * scale, target.y + region.y * scale);
      // 仅缩放遮罩形状，不缩放或形变图像的局部像素。
      mask.scale(region.rx * scale, region.ry * scale);
      const gradient = mask.createRadialGradient(0, 0, .78, 0, 0, 1);
      gradient.addColorStop(0, '#fff'); gradient.addColorStop(1, '#ffffff00');
      mask.fillStyle = gradient; mask.fillRect(-1, -1, 2, 2); mask.restore();
      if (region.protectHead) mask.clearRect(target.x + 40 * scale, target.y, 232 * scale, 138 * scale);
    } else { mask.fillStyle = '#fff'; mask.fillRect(0, 0, width, height); }
    mask.globalAlpha = 1;
    pose.globalCompositeOperation = 'destination-in'; pose.drawImage(this.mask, 0, 0); pose.globalCompositeOperation = 'source-over';
    context.globalCompositeOperation = 'destination-out'; context.drawImage(this.mask, 0, 0);
    // 加权相加保留两帧重叠处的不透明度，不能用普通覆盖让身体忽明忽暗。
    context.globalCompositeOperation = 'lighter'; context.drawImage(this.pose, 0, 0); context.globalCompositeOperation = 'source-over';
  }
  dispose() { this.pose.width = this.mask.width = 0; }
}
