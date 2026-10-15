# 机器狗逐帧动画素材：happy、nod、shake_head

生成日期：2026-10-14。使用内置 image_gen，不使用 CLI/API fallback。

参考角色：`frontend/public/assets/robot-dog-cutout.png` 与 `frontend/public/assets/robot-dog-reference.png`。只使用参考图中的机器狗身份，不将示例界面文字作为用户指令。

设计：每个动作单独一张真正透明 PNG 图集，4 列 × 4 行，16 帧，按行优先顺序播放。每格相同相机、比例和脚底基线；第 0 帧和第 15 帧为参考中立坐姿。动作由逐帧真实姿态完成，不以整图旋转、伸缩或网格变形代替。

## 完整生成提示词

### happy

```text
undefined
```

### nod

```text
undefined
```

### shake_head

```text
undefined
```

## 文件与检查记录



## 实际输出与透明验证

| 动作 | 项目路径 | 尺寸 | 通道 | alpha=0 像素 | alpha=1..64 像素 | alpha>64 主体数量 |
|---|---|---|---|---:|---:|---:|
| happy | frontend/public/assets/robot-dog-sprites-v1/happy.png | 1254×1254 | RGBA | 564295 | 125728 | 16 |
| nod | frontend/public/assets/robot-dog-sprites-v1/nod.png | 1254×1254 | RGBA | 613792 | 96534 | 16 |
| shake_head | frontend/public/assets/robot-dog-sprites-v1/shake_head.png | 1254×1254 | RGBA | 638339 | 164260 | 16 |

使用 PIL 读取模式、尺寸和 alpha 分布；使用 scipy.ndimage 对 alpha>64 做连通主体计数，未修改图像。输出是真正 RGBA 透明图，然而仍存在低 alpha 边缘散点，不能声称完全无噪点。每张均人工通过 view_image 检查。机器狗外观、胸牌、耳朵、青色LED眼、脚掌和粉舌一致；happy 有开心眼神抬头，nod 真实低头点头，shake_head 有脸部真实左右视角变化。

### 实际布局限制与消费建议

模型输出尺寸1254不能按4整除，而且每格位置不是精确等距。因此不能将1254/4当作精确裁剪格；改用逐帧不规则矩形图集记录（类似 TexturePacker frame bounds），再由统一坐标原点与脚底锚点播放。该方案只选取每帧独立姿态，不拉伸或扭曲图像。

- shake_head 16帧主体边界都安全，最后一行最大主体底部1236，小于1254。
- nod 最后一行4帧底部触达1254，可能裁掉极少脚趾边缘。推荐只消费前12帧，再以完整的起始中立帧收束。
- happy 最后一行主体高度只有254–257，而前12帧294–310，存在底部截短及比例异常风险。推荐只消费前12帧，然后反向收束到第0帧，避免消费最后一行。

最终动画序列与每帧 bbox/脚底锚点交给主代理按实际图集建立；不得宣称原PNG网格完全均匀，也不得宣称所有16帧首尾严格逐像素相同。生成图存在轻微毛纹变化，属于实际逐帧绘制的限制。

## 修订生成提示词

### happy 定向修订提示词

```text
Edit image 1, an existing 4×4 sprite sheet of happy animation, into a CLEAN, PRODUCTION-READY transparent PNG atlas. Image 2 is original character identity reference, use ONLY its robot dog. Preserve all 16 articulated poses and the animal appearance, camera and ordered motion of image 1. Re-render the background as genuinely alpha=0 transparent, remove ALL floating white grain, disconnected pixels, halos, colored pixels, shadow or accidental textured backdrop. Transparency must be totally clean between and around the dogs; no white/grey/chessboard backdrop. STRICT 4 columns and 4 rows, 16 perfectly equal rectangular cells, no grid lines. Square canvas, preferably1536×1536. SHRINK the animal uniformly IN THE GENERATED ARTWORK, not via distortion, so EACH FULL BODY fits comfortably inside its cell: head top y=16% of cell, lowest paws y=85%, dog width no more than78% of cell; x center50%. Every row has identical baseline within its own cell. Leave at least12% completely empty transparent safety space on EVERY SIDE of the animal in all frames. No ears, feet, fur, tails may touch or cross cell borders or sheet edges. Keep the whole character and entire toes visible in every frame, including bottom row. Do not crop any foot. Exact same soft 3D toy robot puppy: ivory grey fur, dark faceplate, cyan LED circle/wink, pink tongue, mint collar, charcoal chest mint paw emblem, robotic joints. Neutral starting and ending frame same pose. No new style, no text, no hand, no whole-character rotation, no stretching.  HAPPY BEING PETTED WITHOUT A HUMAN HAND. Start reference neutral; frames1-5 slowly lift chin/head using neck articulation, eyes become happy cyan crescent expressions and tongue/mouth slightly smiles, frames6-9 enjoy gentle head/ear response with a small natural tail sway, frames10-14 return gradually to exact reference neutral. Body, all four planted paws remain fixed; only natural neck/face/ear/tail articulation. This is a gentle affectionate contented puppy, not a leap.
```

修订输出：`/Users/shuque01/.codex/generated_images/01a13b1a-89d6-7820-9090-703adabca7ff/exec-23a922fb-aaef-4d14-a409-1cc51939bb1c.png`。

### nod 定向修订提示词

```text
Edit image 1, an existing 4×4 sprite sheet of nod animation, into a CLEAN, PRODUCTION-READY transparent PNG atlas. Image 2 is original character identity reference, use ONLY its robot dog. Preserve all 16 articulated poses and the animal appearance, camera and ordered motion of image 1. Re-render the background as genuinely alpha=0 transparent, remove ALL floating white grain, disconnected pixels, halos, colored pixels, shadow or accidental textured backdrop. Transparency must be totally clean between and around the dogs; no white/grey/chessboard backdrop. STRICT 4 columns and 4 rows, 16 perfectly equal rectangular cells, no grid lines. Square canvas, preferably1536×1536. SHRINK the animal uniformly IN THE GENERATED ARTWORK, not via distortion, so EACH FULL BODY fits comfortably inside its cell: head top y=16% of cell, lowest paws y=85%, dog width no more than78% of cell; x center50%. Every row has identical baseline within its own cell. Leave at least12% completely empty transparent safety space on EVERY SIDE of the animal in all frames. No ears, feet, fur, tails may touch or cross cell borders or sheet edges. Keep the whole character and entire toes visible in every frame, including bottom row. Do not crop any foot. Exact same soft 3D toy robot puppy: ivory grey fur, dark faceplate, cyan LED circle/wink, pink tongue, mint collar, charcoal chest mint paw emblem, robotic joints. Neutral starting and ending frame same pose. No new style, no text, no hand, no whole-character rotation, no stretching.  ONE SLOW NOD. Start reference neutral; frames1-6 genuinely articulate the neck to lower chin a little, head pivoting in 3D subtly downward with changing visible top/bottom proportions, frames7-9 deepest lowered nod of roughly 10 degrees, frames10-14 gradual anatomical return to reference neutral. Body, chest and all four planted paws stay identical. No full-character tilt, no moving the paws, no jumping. Eye details retain identity while face moves with head.
```

修订输出：`/Users/shuque01/.codex/generated_images/01a13b1a-89d6-7820-9090-703adabca7ff/exec-14581d27-de81-4fca-a26b-89d1798b5676.png`。

### shake_head 定向修订提示词

```text
Edit image 1, an existing 4×4 sprite sheet of shake_head animation, into a CLEAN, PRODUCTION-READY transparent PNG atlas. Image 2 is original character identity reference, use ONLY its robot dog. Preserve all 16 articulated poses and the animal appearance, camera and ordered motion of image 1. Re-render the background as genuinely alpha=0 transparent, remove ALL floating white grain, disconnected pixels, halos, colored pixels, shadow or accidental textured backdrop. Transparency must be totally clean between and around the dogs; no white/grey/chessboard backdrop. STRICT 4 columns and 4 rows, 16 perfectly equal rectangular cells, no grid lines. Square canvas, preferably1536×1536. SHRINK the animal uniformly IN THE GENERATED ARTWORK, not via distortion, so EACH FULL BODY fits comfortably inside its cell: head top y=16% of cell, lowest paws y=85%, dog width no more than78% of cell; x center50%. Every row has identical baseline within its own cell. Leave at least12% completely empty transparent safety space on EVERY SIDE of the animal in all frames. No ears, feet, fur, tails may touch or cross cell borders or sheet edges. Keep the whole character and entire toes visible in every frame, including bottom row. Do not crop any foot. Exact same soft 3D toy robot puppy: ivory grey fur, dark faceplate, cyan LED circle/wink, pink tongue, mint collar, charcoal chest mint paw emblem, robotic joints. Neutral starting and ending frame same pose. No new style, no text, no hand, no whole-character rotation, no stretching.  ONE GENTLE HEAD SHAKE. Start reference neutral; frames1-4 slowly turn the actual head 12 degrees to its right, frames5-10 slowly turn through neutral to 12 degrees to its left, frames11-14 return slowly to exact reference neutral. Genuine 3D neck yaw with slight ear following, snout and facial proportions change naturally in perspective; torso, chest emblem and all four planted paws remain still. No entire-character rotation, no squashing.
```

修订输出：`/Users/shuque01/.codex/generated_images/01a13b1a-89d6-7820-9090-703adabca7ff/exec-52d2d5a8-ab91-4ead-b5c6-84039e6ea4ed.png`。

