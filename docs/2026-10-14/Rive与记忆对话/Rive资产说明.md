# Rive 熊猫资产说明

## 交付内容

- `frontend/public/assets/panda.riv`：15,742 字节，RIVE 二进制头，真实纯矢量动画，画板 640×700，透明场景。
- `frontend/public/assets/panda-rive-avatar.png`：官方 CLI 渲染的 640×700 静态头像，RGBA，但 alpha 全为 255（无透明像素）。CLI 默认清屏色为 #1D1D1D，头像带灰黑底；这不代表 .riv 画板有背景填充。
- `frontend/public/assets/panda-rive-contract.json`：机器可读契约。
- `rive/panda/scene.rml`：最终矢量场景、ViewModel、双层状态机与嵌入时间线。
- `rive/panda/generate_panda.py`：可重建的源生成器；`animation-*.rml`：独立可读时间线源。
- `rive/panda/validate_asset.py`：编译、结构和真实 headless 渲染的校验脚本。

素材没有 Image / ImageAsset / Script / 精灵图对象，使用 61 个 Shape 和 11 个 Node。奶白脸和胸腹、深蓝黑四肢、耳朵、眼圈采用矢量渐变；眼睛、高光、闭眼弧、爪垫、鼻嘴均为矢量。风格为圆润的插画熊猫，不能宣称等同原稿的照片级毛发。

## 网页运行契约

`artboard: 'Panda'`、`stateMachine: 'Panda'`、`autoBind: true`，默认 ViewModel 为 `PandaControl`。输入 `action` 是 number，`perform` 是 trigger。

```ts
const vm = runtime.viewModelInstance;
vm.number('action').value = actionId;
vm.trigger('perform').trigger();
```

先写数字，再触发一次。只改数字不会自动播放，持续保留同一数字不会在动作完成后反复播放。可用 `action=0` 和 `perform` 中断当前动作并平滑回待机。暂停与恢复由 runtime.pause()/play() 控制，素材没有 paused 输入。

| 数字 | 时间线 | 时长 | 真实动画 |
| --- | --- | --- | --- |
| 0 | idle | 4 秒循环 | 头部小幅摆动、前肢微动 |
| 1 | blink | 0.55 秒 | 眼球垂直形变与闭眼弧显隐 |
| 2 | wave | 1.8 秒 | 肩部旋转举起单爪，多次摆爪，掌垫随爪旋转 |
| 3 | nod | 1.25 秒 | 头部上下移动并压缩，连续点头 |
| 4 | shake_head | 1.5 秒 | 头部横移、转动并压缩，左右摇头 |
| 5 | stretch | 2.8 秒 | 双肩旋转举爪，头部伸展 |
| 6 | happy | 1.9 秒 | 双爪举起摆动、头部微跳、张嘴露舌 |
| 7 | sleep | 4 秒 | 慢慢闭眼、歪头下沉打盹，然后睁眼回待机 |

常驻 breathing 层以 4 秒周期围绕脚底锚点微缩放（1→1.012→1），动作层始终保留呼吸。7 种一次动作以 140ms 混合进入，时间线末尾经 180ms 回 idle。数字 0 的回待机混合为 180ms。所有时间线 60fps 并有 cubic 插值。

## 验收证据

官方 CLI `--verify --format=json` 为 0 errors / 0 warnings；`inspect --json` 的 problems 为空。25 项结构和真实渲染检查均通过。动作触发截图与同一时间点的待机截图 SHA256 均不同，并人工查看了各动作。

截图保存在本目录 `screenshots/`，全由官方 CLI 生成。`wave_return.png` 在保持 action=2 的情况下推进到第 200 帧，已回到垂爪的待机形态，证明触发器不会因数字持续存在而重复播放。`idle_start.png` 与 `idle.png` 是待机开始和第 120 帧。

头像灰色底的限制：CLI 1.5.1 help/docs 没有透明清屏截图标志，尚未以该工具产出 alpha PNG；正式 Rive 无画板 Fill，不会遮盖页面房间背景。可由网页已集成的官方运行时在透明 canvas 中导出独立静态头像，或使用旧透明静态头像；此说明不把该 PNG 当作动画资源。

## 官方依据

https://rive.app/docs/cli/overview

https://rive.app/docs/cli/getting-started

https://rive.app/docs/runtimes/advanced-topic/rml

类型、属性与触发器比较符依据随 CLI 附带的官方 schema/docs，未使用猜测的 API。
