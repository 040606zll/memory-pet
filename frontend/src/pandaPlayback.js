/** 脚底锚点统一了不同动作的绘制坐标，避免切换动作时整体漂移。 */
export function poseGeometry(pose, width, height) {
  const { frame, referenceSize } = pose;
  const scale = Math.min(width / referenceSize, height / referenceSize);
  return { x: width / 2 - frame.anchorX * scale, y: height - 8 - frame.anchorY * scale, width: frame.width * scale, height: frame.height * scale };
}

export function poseAt(assets, name, index = 0) {
  const descriptor = assets.manifest.actions[name] || assets.manifest.actions.idle;
  return { key: `${descriptor.sheet}:${index}`, image: assets.sheets[descriptor.sheet], frame: descriptor.frames[index], referenceSize: descriptor.frames[0].width };
}

/** 按完整动作时长采样关键帧；首尾回到同一闲置姿态，不再以 fps 提前钳制到末帧。 */
export function sampleMotion(assets, state) {
  const neutral = poseAt(assets, 'idle');
  if (state.started == null) return { from: neutral, to: neutral, mix: 0 };
  const descriptor = assets.manifest.actions[state.name] || assets.manifest.actions.idle;
  const sequence = [...descriptor.sequence];
  if (sequence.at(-1) !== sequence[0]) sequence.push(sequence[0]);
  const edge = Math.min(0.15, 160 / state.duration_ms);
  const progress = Math.max(0, Math.min(1, state.progress));
  const first = poseAt(assets, state.name, sequence[0]);
  let from, to, mix;
  if (progress < edge) {
    from = neutral; to = first; mix = progress / edge;
  } else if (progress > 1 - edge) {
    from = first; to = neutral; mix = (progress - 1 + edge) / edge;
  } else {
    const position = (progress - edge) / (1 - edge * 2) * (sequence.length - 1);
    const index = Math.min(sequence.length - 2, Math.floor(position));
    from = poseAt(assets, state.name, sequence[Math.max(0, index)]);
    to = poseAt(assets, state.name, sequence[Math.max(0, index + 1)]);
    mix = sequence.length === 1 ? 0 : position - index;
  }
  // 平滑速度的接入和退出，保留浏览器每次刷新的独立中间姿态。
  return { from, to, mix: mix * mix * (3 - 2 * mix) };
}

export function drawPose(ctx, pose, width, height) {
  const rect = poseGeometry(pose, width, height);
  const { frame } = pose;
  ctx.drawImage(pose.image, frame.x, frame.y, frame.width, frame.height, rect.x, rect.y, rect.width, rect.height);
}

/** 加权相加避免半透明交叠区域变暗；这也是不支持增强渲染时的兼容路径。 */
export function drawBlend(ctx, motion, width, height, opacity = 1) {
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = (1 - motion.mix) * opacity;
  drawPose(ctx, motion.from, width, height);
  if (motion.mix > 0) {
    ctx.globalAlpha = motion.mix * opacity;
    drawPose(ctx, motion.to, width, height);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** 动作被打断时从屏幕上的当前姿态交接，避免跳回默认图再开始新动作。
 * 快照仅在动作交接时复制一次；每帧复用同一个缓冲画布，不分配新图片。
 */
export function createPandaPainter(canvas, context) {
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width; snapshot.height = canvas.height;
  const snapshotContext = snapshot.getContext('2d');
  let previousKey, transitionStarted = -Infinity;
  return (motion, state, time) => {
    const key = `${state.name}:${state.started ?? 'rest'}`;
    if (previousKey != null && previousKey !== key && snapshotContext) {
      snapshotContext.clearRect(0, 0, snapshot.width, snapshot.height);
      snapshotContext.drawImage(canvas, 0, 0);
      transitionStarted = time;
    }
    previousKey = key;
    const elapsed = Math.max(0, Math.min(1, (time - transitionStarted) / 160));
    const opacity = elapsed * elapsed * (3 - 2 * elapsed);
    drawBlend(context, motion, canvas.width, canvas.height, opacity);
    if (opacity < 1) {
      context.globalCompositeOperation = 'lighter';
      context.globalAlpha = 1 - opacity;
      context.drawImage(snapshot, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
    }
  };
}
