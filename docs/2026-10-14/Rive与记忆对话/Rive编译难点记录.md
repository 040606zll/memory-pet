# RML 导出与官方 CLI 验证难点

## 时间线对象能 inspect 却无法导出

复现：把 `<LinearAnimation artboardId="0:2">` 放在独立 RML 顶层，在时间线关键帧中嵌套 CubicEaseInterpolator，状态机引用其 animationId。CLI inspect 能发现这些对象，但 --verify 报 `KeyFrameDouble interpolatorId targets a CubicEaseInterpolator that is not exported`，同时报 `AnimationState animationId targets a LinearAnimation that is not exported`。

原因与解决：1.5.1 导出器需要时间线成为 Artboard 的真实子元素。仅写 artboardId 引用没有形成正确导出范围。源生成器保留独立文件供审查，再将其时间线嵌入 scene.rml 的 Artboard；rive.yaml exclude 独立文件，避免重复 ID。嵌入后的时间线必须去掉 artboardId，否则出现 implied-reference-authored 问题。修复后 --verify 和 inspect problems 均为空。

## 画板样式和羽化

无 LayoutComponentStyle 时 inspect 会报 artboard-without-style。补一个 style 并设 Artboard.styleId 即可。羽化填充要显式指定 fillRule=clockwise，否则可能编译无误却不绘制；这些视觉问题必须看官方 CLI 截图。

## CLI 模式互斥和输出背景

--once 与 --screenshot 不能同时使用；--screenshot 本身已经编译 .riv。截图固定采用 CLI 灰色清屏背景；目前帮助与文档没有公开透明清屏选项。不要把无 alpha 的截图误称为透明，不要为此给正式 .riv 加背景。正式网页使用透明画板。

## 防止动作重复播放

只用 action 数字作为 AnyState 条件会在持续保持数字时重复触发。每个动作入口必须同时比较 action 与 perform Trigger，数字只选动作、触发器负责一次执行。真实截图验证保持 action=2、推进 200 帧后已经返回 idle。
