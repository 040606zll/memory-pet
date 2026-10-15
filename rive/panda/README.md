# 熊猫 Rive 矢量资产

本工程由官方 Rive CLI 1.5.1 的 RML 编译。熊猫是 61 个矢量 Shape、11 个 Node，没有图片、精灵图集或 Luau 脚本。旧 PNG 素材仅作为历史参考，不会被本工程编译。

生成器 `generate_panda.py` 负责形体、渐变、动画关键帧和 ViewModel 状态机。`scene.rml` 为最终编译入口；独立的 `animation-*.rml` 是便于审查的时间线源，已在 rive.yaml 排除重复编译。各 RML 文件少于 1,000 行。

复现命令（项目根目录）：

```bash
python3 rive/panda/generate_panda.py
.runtime/tools/rive/bin/rive rive/panda --verify
.runtime/tools/rive/bin/rive rive/panda --once
python3 rive/panda/validate_asset.py
```

时间线/输入契约详见 `../../frontend/public/assets/panda-rive-contract.json` 和 `../../docs/2026-10-14/Rive与记忆对话/Rive资产说明.md`。重新构建后应人工审查官方 CLI 截图，再复制 build/panda.riv 至正式素材目录。只跑生成器不会覆盖正式目录文件。

官方参考：https://rive.app/docs/cli/overview、https://rive.app/docs/cli/getting-started、https://rive.app/docs/runtimes/advanced-topic/rml 。
