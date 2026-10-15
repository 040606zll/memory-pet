# 素材 B 进度

- 负责动作：happy、nod、shake_head；未修改任何主程序。
- 已阅读 imagegen SKILL，已使用 view_image 检查原机器狗参考和抠图。
- 使用内置 image_gen 各生成一次，再针对透明噪点与跨格问题各修订一次；源图保留在 Codex generated_images 中。
- 已复制三张修订 RGBA 图集到 `frontend/public/assets/robot-dog-sprites-v1/`，实际尺寸均1254×1254。
- 已通过只读 alpha>64 连通主体检查，每张恰好16个主体；已逐张进行视觉检查。
- 实际限制：图集不是严格均匀格，需不规则 frame bounds；happy 末行比例截短、nod 末行脚底贴边，建议只消费前12帧后返回中立；shake_head 全16帧安全留边。
- 完整生成/修订提示词、实际源路径、透明分布、检查限制已记录于 `docs/2026-10-14/机器狗逐帧动画/素材-happy-nod-shake.md`。
- 已将资产与限制及时发送主代理，动画播放序列、锚点和浏览器验证由主代理统一验收。
