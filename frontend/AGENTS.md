# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## 宠物动画反馈

最新用户明确否定图片拉伸/共享网格形变，要求参考GitHub的精灵帧方案重新实现。使用原型中的毛绒机器狗，保持布局、训练/正式对话、主动交互和无人操作时的自然动作。`RobotDog.jsx`只使用`dogSpriteAssets.js`与`dogSpritePlayer.js`；正式主体由预绘制真实姿态帧播放，不再导入旧dogMotion/dogRenderer进行像素形变。原图只继续用于静态头像和素材身份参考。

全部图集加载并解码完成才启用互动；只在常驻canvas提交完整帧，禁止逐帧改img.src或重建canvas。源帧矩形和脚底锚点按实际图像测量，不把生成图当成严格均分网格；每个动作使用固定等比尺度，不随单帧宽高缩放角色。happy/nod底行不合格帧排除，播放序列首尾回同一中立帧。暂停保留画面和活动时钟，恢复衔接冻结帧，不重放旧动作。

必须验证实际动作姿态、源图片帧推进、脚底、完整画布像素和模式切换。浏览器刷新次数不能冒充真实动画帧数。保留MemoryOS引用，不恢复“小忆记得”列表。旧熊猫/Rive与网格资产仅保留历史，主页面不加载。

## 普通记忆对话

`/memory` 是独立的普通助手页面，无宠物人格和动作。复用真实 MemoryOS 写入、召回、候选修改及确认链路，必须取得远端记忆编号才显示写入成功。使用 `surface=memory` 隔离本地历史，默认宠物会话保持兼容。新会话召回应使用空聊天历史验证，不能以同一会话上下文冒充长期记忆。前端采用分包路由，普通页无需加载 Rive 运行时。

机器狗排队时长必须匹配SPRITE_DURATIONS与图集manifest的duration_ms，不能沿用旧网格或Rive周期。暂停/预览期间的旧actions不得在恢复时重新入队；恢复时需从冻结姿态平滑回闲置，页面标签与画面一致。

## 2026-10-15 持续抽动反馈

用户指出逐帧版仍像抽搐。安静状态必须保持同一中立图，不允许16张全身待机图每1.6秒循环冒充呼吸。机器狗使用DogBehavior专用节奏：自主活动仅稀疏眨眼/偶尔摇尾，大动作由用户或回复触发；共享PetMachine保持其他角色默认行为。

小动作通过DogFramePainter更新活动部位，躯干与静止脚保持中立图。真实源图片帧之间局部混合，没有局部拉伸；所有动作起止共用同一中立图。静止ROI必须有实际主体像素，使用预乘RGBA并统一诊断Canvas读回方式；不能以透明像素原始RGB差、空画布比较、没有空白帧或帧数量作为自然度通过证明。

当前验收以tests/dog-continuity-visual.html及docs/2026-10-15/宠物动作持续抽动为准。完整身体大动作和生成运动区仍受素材质量限制，不能宣称已达到真实视频自然度。

## 2026-10-15 再次严重闪动反馈

上一节验收被用户再次否定，仅静止ROI通过不能证明动作区合格。当前主页面使用dogFrameAtlas.js在加载阶段从同一角色的刚性部件烘焙完整图片帧，Sprite播放器一帧只画一张图。禁止恢复DogFramePainter的双姿态透明混合、动作交叉淡化或各动作独立生成的变脸图。不得以头部、躯干尺寸变化冒充运动。

采用30Hz时间采样，重复姿态共享图集位置；首尾和待机使用同一物理帧。自主动作继续保持稀疏，暂停冻结，恢复沿图片帧回中立。当前真实像素检查为tests/dog-temporal-visual.html?coherent=1，报告位于docs/2026-10-15/机器狗整帧闪动。旧诊断页与旧素材保留历史，不能作为当前主页面验收。双脸重影检查不等于真实动物自然度认证；当前是小幅二维部件动作，不能描述为真实三维或完整身体舒展。

## 文字输入

宠物训练和正式对话支持文字及真实流式语音输入。麦克风经 AudioWorklet 转为 PCM16，由带登录校验的后端 WebSocket 转发百炼识别，增量转写进入草稿，用户确认发送。回复使用 SSE 和服务端 Qwen-Audio-TTS（longjielidou_v3.6），按 PCM 播放时钟和字级时间戳逐步显示；默认开启语音，可在菜单关闭。宠物消息不展示“用到记忆”标签，后台继续真实召回。语音密钥及供应商地址仅由后端配置。

训练与正式对话（普通页为写入与召回）各自保留会话 ID、消息、草稿和失败重试状态；切换标签恢复对应会话，首次发送时按模式创建会话。已确认的长期记忆仍按用户共享，用于独立会话中的召回。

## 大模型配置

大模型地址、API Key 和模型名称仅由宠物后端配置文件或环境变量管理，环境变量优先于 `backend/config.local.toml`，再优先于 `backend/config.toml`。两种页面的记忆服务弹窗仅展示状态及重试；连接参数由后端统一配置，连接接口拒绝客户端提交地址、Key、UUID 或模型配置。

前端到宠物后端的 API 基础地址统一写在 `src/config.js`，由 `src/api.js` 读取，修改后重新构建。默认 `/api` 通过同源代理转发；配置文件会公开，禁止存放密钥。不在页面增加宠物后端地址输入。

## 账号密码登录（2026-10-15 用户确认）

两个业务页面统一由 AuthProvider/AuthGate 保护，只提供账号密码登录和注册。MemoryOS 地址与服务 Key 由后端管理，每个本地账号固定关联一个独立 MemoryOS 用户；页面“记忆服务”仅展示状态与重试。模型是否已配置由 llm.configured 表示，不能表述为实际模型调用已验证。

登录凭据由 HttpOnly Cookie 管理，CSRF 只在内存；变更请求附带 X-CSRF-Token。401、退出和账号变化时卸载旧业务树，旧请求成功或失败都不能覆盖新账号。重新聚焦校验期间隐藏业务界面，同一账号校验成功应保留草稿。连接与身份逻辑改动时运行 tests/auth.test.jsx 及业务回归；接口约定见 ../docs/2026-10-15/账号密码登录/API接口文档.md。

开发代理将公开 /pet-api 路径改写为后端 /api；配置地址只能放在 src/config.js。

## 2026-10-15 3D 宠物（用户确认方案）

主页面宠物改为 Three.js + @react-three/fiber 实时 3D。模型由 `tools/blender/build_dog.py` 在 Blender 中脚本生成（元球造型、自动权重骨架、顶点色花色，alpha 为毛长），导出 `public/assets/pet3d/dog.glb`，前端 `dogModel.js` 加载并叠毛绒外壳着色器；用户要求腿部不要机械关节和发光环。房间仍为 2D 背景 `robot-dog-room.png`。代码在 `src/pet3d/`，`PetStage` 在不支持 WebGL2 或 `?pet=2d` 时回退原 2D 精灵版。驱动协议见 ../docs/2026-10-15/3D宠物/API接口文档.md，服务端未实现前使用本地 mock（`PET_DRIVER_MODE`）。`?pet-debug` 暴露 `window.__pet` 便于调试。改造型须改 Blender 脚本并重新导出，不在运行时生成网格（避免卡顿）。比例以 tools/blender/reference/design.webp 实测为准（脚本头部注释列出数值）；眼罩、嘴等面部花色由 furMaterial 着色器按眼睛实际位置逐像素绘制，环境光遮蔽烘焙在顶点色里，主光投射阴影。

2026-10-15 更新：主模型换成用户提供的 Tripo 生成模型（原始文件 `tools/blender/source/puppy_tripo.glb`，71MB、200 万面、无骨架）。`tools/blender/rig_tripo_dog.py` 负责减面到约 8 万面、贴图压到 2048/1024 WebP、按实测位置绑定与 GLB_BONE_MAP 同名的骨架，导出 `public/assets/pet3d/puppy.glb`（约 3.5MB）。花色、嘴、舌头烘焙在 PBR 贴图里，`PUPPY_BONE_MAP.fur=false` 时不叠毛绒外壳；下巴骨不参与变形。旧 `dog.glb` 与 `build_dog.py` 保留作回退。卧/睡姿态的 hipsY、低头幅度已按新模型较大的头部调小。

眼睛（用户多次否定贴纸式方案：浮在脸上的眼片、画布自绘眼睛、在原眼图上画 2D 眼睑都不自然；又指出眼球与眼眶对不上、有空洞、太凸）：脚本按贴图颜色找出原模型整颗眼睛的面片（黑瞳孔/青虹膜/浅眼白，从眼心连通），用这些顶点最小二乘拟合球体作为眼球（Eye_L/Eye_R，挂 head 骨），凸出程度与原模型一致；瞳孔、虹膜按面片内密集取样换算成球冠程序化绘制贴图，眼眶开口轮廓按方位角平滑后删面、把边缘收进眼球表面下，眼球贴图带贴近开口的接触阴影描边。眼眶附近皮肤权重全给 head 骨，避免动作时皮肤与眼球错位。extras 带 lid_color、radius、axis（瞳孔朝向）、opening_axis/opening（开口轴与最大张角）。前端 `eyeRig.js`：看向时整颗眼球转动；眼睑是只覆盖开口的薄球冠，着色器按仰角裁切出上/下眼睑边（经过眼角的大圆，带深色睑缘），表情对应边缘角度见 LID_POSES；反光点沿瞳孔朝向固定在眼窝。不要再回到 2D 贴图式眼睑或整颗半球壳眼睑（闭眼会鼓出眼眶）。调眼睛时用 `tools/blender/compare_eyes.py` 与原模型多视角对比渲染。

