# 机器狗眨眼、挥爪、摇尾巴逐帧素材

任务开始于2026-10-14，素材完成于2026-10-15。使用内置 imagegen，每动作独立调用，首轮三张和定向修订三张分别并行。未调用CLI/API、未安装依赖、未修改业务代码、未删除历史资产。Python只读取图片元数据与帧边界，没有编辑或写出图片像素。

## 最终资产

| 动作 | 项目路径 | 尺寸与格式 | 选用轮次 | 脚底实际百分比 |
| --- | --- | --- | --- | --- |
| blink | frontend/public/assets/robot-dog-sprites-v1/blink.png | 1254×1254 RGBA，alpha 0..255 | 首轮，身份更接近cutout且外围噪点较少 | 98.41%..99.04% |
| wave | frontend/public/assets/robot-dog-sprites-v1/wave.png | 1254×1254 RGBA，alpha 0..255 | 修订轮，留白更充分 | 93.61%..93.95% |
| wag_tail | frontend/public/assets/robot-dog-sprites-v1/wag_tail.png | 1254×1254 RGBA，alpha 0..255 | 修订轮，主体不跨格边 | 95.85%..96.17% |

每张4列4行、行优先共16帧。全图除以4为313.5像素，因此 sourceRect 用浮点均分格；只读整数像素检测以round后的0、314、627、940、1254边界计算。 metadata.json 保存每帧 sourceRect、alpha>10主体bbox、脚底anchorYLocal、实际高度和帧散列。16帧像素数据全部不同，但散列不同本身不证明动作；动作另经目视验收。

## 真实验收与限制

- blink：源图右眼wink保持，左眼从圆形LED眼逐步收窄、闭成青蓝弧线再睁开，头部和身体基本保持坐姿。
- wave：近侧前爪从地面逐渐抬起、弯曲至脸側、摆动/转爪、再放下，无第三条前肢。修订版保留了更宽留白。
- wag_tail：尾巴有左伸、直起、向内弯曲的连续形态变化，主体和脚底基本稳定。
- 均无文本、房间、界面卡片、网格线或帧标签。alpha>10的主体在全部16格中都不触边，不裁掉耳、尾、爪。
- 工具实际输出1254方图，未输出建议1536方图。
- 未满足严格85%脚底基线；角色约有1px帧间锚点偏差。三个动作的角色画幅大小也不同，需要以固定动作单位比例和脚底锚点对齐。此为素材导出对齐，不能用整体拉伸或网格形变冒充动画。
- 帧0与15为同一中性坐姿，但生成式渲染存在毛纹/高光细微变化，并非逐像素完全相同。
- 背景确有alpha0透明像素，但存在alpha1..10低透明度噪点，blink为116,377像素、wave为466,584像素、wag_tail为269,119像素。不能称作完美干净alpha。更高alpha阈值的主体范围稳定，主代理可读连通主体真实bbox进行取帧；本worker没有改图。
- 此次是多张真实动作帧，主代理应逐帧播放；旧图片拉伸/网格形变路线已被用户拒绝，不应继续使用。

## 参考输入

- frontend/public/assets/robot-dog-reference.png：706×500原型，左侧原机器狗身份。
- frontend/public/assets/robot-dog-cutout.png：1490×1055透明全身，首轮作身份参考；修订轮仅用原型，避免继承抠图边缘噪点。

## 工具原始文件（原样复制）

- blink：/Users/shuque01/.codex/generated_images/01a13a17-664b-7582-95fb-5827c66fd31d/exec-29fb92a3-7e93-4a7c-a38b-1cd13257dbb5.png
- wave：/Users/shuque01/.codex/generated_images/01a13a17-664b-7582-95fb-5827c66fd31d/exec-27bba310-3af6-415f-ac5f-07cc25a5b5f5.png
- wag_tail：/Users/shuque01/.codex/generated_images/01a13a17-664b-7582-95fb-5827c66fd31d/exec-15b71d7c-64ee-40c7-b916-086f85ff8169.png

其余候选仍保留内置生成目录，没有删除或覆盖。

## blink 完整最终提示词

```text
Use case: identity-preserve.
Asset type: true raster frame animation sprite atlas for a pet webpage.
References: image 1 is the transparent cutout of the exact plush robot dog identity; image 2 shows its original prototype. Use ONLY the dog, never any UI or room. Preserve gray-and-cream plush fur, floppy gray ears, black-gray LED eye mask, cyan blue bright round LEFT eye and cyan winking RIGHT eye, tiny black nose, pink tongue, mint collar with glowing paw chest badge, robot elbow joints and black toe tips. Same proportions, fur and color identity in every frame.
Output ONE SQUARE PNG transparent sprite sheet, suggested 1536x1536. EXACTLY 4 evenly spaced columns and 4 evenly spaced rows = 16 individual FULL-BODY frames. Strict uniform invisible grid, NO drawn lines, NO labels or numbers. Frame order is row-major, left to right, top to bottom. One single dog per cell. Genuinely transparent alpha everywhere except dogs, no opaque/checkerboard background, no floor, no cast shadows, no furniture, no text. All frames use identical fixed camera, same sitting pose body, identical scale and body x position. Dog centered horizontally at exactly 50% of EACH cell, planted paw baseline at exactly 85% of EACH cell height. Full height 75% of each cell, with generous transparent margin around ears/tail/paws. Dog must not cross or touch cell boundaries.
Animation uses real separate successive poses and facial drawings, NOT overall-image rotation, NOT global squash, NOT global resize, NOT duplicate static poses. Preserve the original head tilt and seated trunk throughout. The moving part alone changes in small continuous increments. Frames 0 and 15 are the same source neutral pose. Do not fill all frames with the same pose. The intervening fourteen drawings describe a smooth physical motion.
Action BLINK: the large round cyan LED LEFT eye blinks once while the RIGHT LED eye remains in its source wink shape. Frames 0,1: source left eye fully open. Frames 2,3,4: eyelid/screen eye progressively narrows to 75%,50%,25% height. Frames 5,6,7: closed cyan curved lid. Frames 8,9,10: progressively opens 25%,50%,75%. Frames 11,12,13,14,15: returns source fully open with subtle settling, no head/body movement. Draw proper progressive eye shapes, keep eye mask and reflected highlights coherent.
```

## wave 完整最终提示词

```text
Use case: identity-preserve.
Asset type: true raster frame animation sprite atlas for a pet webpage.
References: image 1 is the exact original prototype, with the source dog in the left room. Use ONLY the dog, never any UI or room. Preserve gray-and-cream plush fur, floppy gray ears, black-gray LED eye mask, cyan blue bright round LEFT eye and cyan winking RIGHT eye, tiny black nose, pink tongue, mint collar with glowing paw chest badge, robot elbow joints and black toe tips. Same proportions, fur and color identity in every frame.
Output ONE SQUARE PNG transparent sprite sheet, suggested 1536x1536. EXACTLY 4 evenly spaced columns and 4 evenly spaced rows = 16 individual FULL-BODY frames. Strict uniform invisible grid, NO drawn lines, NO labels or numbers. Frame order is row-major, left to right, top to bottom. One single dog per cell. Genuinely transparent alpha everywhere except dogs, no opaque/checkerboard background, no floor, no cast shadows, no furniture, no text. All frames use identical fixed camera, same sitting pose body, identical scale and body x position. Dog centered horizontally at exactly 50% of EACH cell, planted paw baseline at exactly 85% of EACH cell height. Full height 75% of each cell, with generous transparent margin around ears/tail/paws. Dog must not cross or touch cell boundaries.
Animation uses real separate successive poses and facial drawings, NOT overall-image rotation, NOT global squash, NOT global resize, NOT duplicate static poses. Preserve the original head tilt and seated trunk throughout. The moving part alone changes in small continuous increments. Frames 0 and 15 are the same source neutral pose. Do not fill all frames with the same pose. The intervening fourteen drawings describe a smooth physical motion.
Action WAVE: the nearer front paw directly under the dog's large open LED eye lifts naturally toward its cheek, waves gently twice from its robot shoulder/elbow, and returns to its original planted position. Frames 0 neutral seated with both front paws down. Frames 1,2,3 progressively bend and raise that one front paw. Frames 4,5,6 reach cheek height and swing gently out. Frames 7,8,9 swing gently in then out, showing consistent paw toes/pads and real elbow bend. Frames 10,11,12 begin to lower with shoulder/elbow articulation. Frames 13,14,15 settle back into exactly source neutral pose. Other planted feet and trunk stay fixed at baseline. The head keeps original tilt, eye/tongue/collar unchanged. Make the raised paw clearly visible, never create a third forelimb.
CRITICAL LAYOUT AND ALPHA CORRECTION:
Use the supplied original prototype for the dog's identity; do not carry over UI, room or transparent-mask specks.
Keep exactly FOUR ROWS and FOUR COLUMNS. Make every dog notably SMALLER than a tightly packed atlas: full character height about 65% of its cell, leaving at least 15% empty transparent top margin and 15% empty transparent bottom margin. Planted feet in every cell should sit at 85% of cell height. Every dog, including all ears, toes and tail fur, stays comfortably inside its equal-sized cell. Never extend paws across a row boundary. Canvas square. Body scale, fixed seated pose, foot baseline, and camera are identical across all 16 cells. No changing body proportions or head tilt, only the required moving part.
ALL outside-dog pixels must be truly alpha=0, completely clean empty transparent space. NO white speckles, NO colored edge noise, NO background clouds, NO furry debris, NO ground. Preserve softly anti-aliased fur immediately on the dog silhouette, but no semitransparent pixels elsewhere. No shadow under paws.

```

## wag_tail 完整最终提示词

```text
Use case: identity-preserve.
Asset type: true raster frame animation sprite atlas for a pet webpage.
References: image 1 is the exact original prototype, with the source dog in the left room. Use ONLY the dog, never any UI or room. Preserve gray-and-cream plush fur, floppy gray ears, black-gray LED eye mask, cyan blue bright round LEFT eye and cyan winking RIGHT eye, tiny black nose, pink tongue, mint collar with glowing paw chest badge, robot elbow joints and black toe tips. Same proportions, fur and color identity in every frame.
Output ONE SQUARE PNG transparent sprite sheet, suggested 1536x1536. EXACTLY 4 evenly spaced columns and 4 evenly spaced rows = 16 individual FULL-BODY frames. Strict uniform invisible grid, NO drawn lines, NO labels or numbers. Frame order is row-major, left to right, top to bottom. One single dog per cell. Genuinely transparent alpha everywhere except dogs, no opaque/checkerboard background, no floor, no cast shadows, no furniture, no text. All frames use identical fixed camera, same sitting pose body, identical scale and body x position. Dog centered horizontally at exactly 50% of EACH cell, planted paw baseline at exactly 85% of EACH cell height. Full height 75% of each cell, with generous transparent margin around ears/tail/paws. Dog must not cross or touch cell boundaries.
Animation uses real separate successive poses and facial drawings, NOT overall-image rotation, NOT global squash, NOT global resize, NOT duplicate static poses. Preserve the original head tilt and seated trunk throughout. The moving part alone changes in small continuous increments. Frames 0 and 15 are the same source neutral pose. Do not fill all frames with the same pose. The intervening fourteen drawings describe a smooth physical motion.
Action WAG TAIL: only the raised fluffy curved tail behind the dog's left side sways left and right naturally from its base while head, trunk, paws, face and collar stay fixed. Frame 0 source tail neutral. Frames 1,2,3 tail gradually sweeps farther left, 4,5 reaches leftmost curve. Frames 6,7,8 sweeps across neutral and reaches more upright/rightward curve, 9,10 rightmost curve. Frames 11,12,13 sways back gently, 14,15 returns exactly source neutral tail. Clearly different continuous tail curves and directions, no extra tail, no body rotation. Tail stays visible behind left flank within transparent cell margins.
CRITICAL LAYOUT AND ALPHA CORRECTION:
Use the supplied original prototype for the dog's identity; do not carry over UI, room or transparent-mask specks.
Keep exactly FOUR ROWS and FOUR COLUMNS. Make every dog notably SMALLER than a tightly packed atlas: full character height about 65% of its cell, leaving at least 15% empty transparent top margin and 15% empty transparent bottom margin. Planted feet in every cell should sit at 85% of cell height. Every dog, including all ears, toes and tail fur, stays comfortably inside its equal-sized cell. Never extend paws across a row boundary. Canvas square. Body scale, fixed seated pose, foot baseline, and camera are identical across all 16 cells. No changing body proportions or head tilt, only the required moving part.
ALL outside-dog pixels must be truly alpha=0, completely clean empty transparent space. NO white speckles, NO colored edge noise, NO background clouds, NO furry debris, NO ground. Preserve softly anti-aliased fur immediately on the dog silhouette, but no semitransparent pixels elsewhere. No shadow under paws.

```

