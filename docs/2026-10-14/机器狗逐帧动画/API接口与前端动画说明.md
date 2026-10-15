# 机器狗逐帧动画说明

任务从2026-10-14开始，2026-10-15完成。用户否定单图拉伸，要求参考GitHub的图片帧实现。本轮替换角色播放器，保持页面布局、训练与正式对话、MemoryOS API和后端行为。没有新增后端接口、修改凭据、依赖或部署配置。

## 实现依据

参考 [PixiJS AnimatedSprite](https://github.com/pixijs/pixijs/blob/dev/src/scene/sprite-animated/AnimatedSprite.ts) 的时间推进、帧序列和纹理切换，以及 [Phaser AnimationState](https://github.com/phaserjs/phaser/blob/master/src/animations/AnimationState.js) 的动作状态播放机制。复用现有PetMachine，使用原生Canvas2D，没有复制两库源码或新增游戏引擎依赖。

原网格形变无法提供真正的抬爪、伏低等姿态，继续调拉伸幅度不能解决用户反馈。此次制作九个透明图集，每张含16个独立预绘制姿态。源素材共144帧，排除happy和nod末行8个比例或裁边不合格帧，正式序列使用136个不同姿态。角色身份沿用原稿，但生成姿态的毛纹等细节不是原图逐像素复制。

## 文件与职责

- `frontend/src/dogSpriteAssets.js`：读取manifest，校验边界/锚点/序列，预加载并解码九个图集，失败、取消和卸载释放ImageBitmap。
- `frontend/src/dogSpritePlayer.js`：活动时钟、源帧选择、固定比例与脚底定位、离屏完成画面后一次提交、动作交接。
- `frontend/src/RobotDog.jsx`：接入真实姿态播放器，复用动作队列、主动按钮、语言动作和自主闲置，处理暂停、预览、加载重试与卸载。
- `frontend/public/assets/robot-dog-sprites-v1/*.png`及`manifest.json`：真实RGBA图集、逐帧源矩形、脚底锚点和播放顺序。metadata.json只记录素材，不作为运行时均分裁切依据。
- `frontend/tests/dogSpriteAssets.test.js`、`dogSpritePlayer.test.js`、`robotDog.test.jsx`：加载、完整帧提交和交互回归。
- `frontend/tests/dog-sprites-visual.html`：使用生产播放器的浏览器验收页，记录真实关键帧和整画布透明像素检测。
- `frontend/AGENTS.md`、`README.md`、`design-qa.md`及本目录：持久化用户反馈和当前验收记录。

没有删除旧熊猫、Rive或网格文件；它们不进入主页面角色播放链路。App.jsx、styles.css、记忆业务及后端本轮未修改。

## 帧与防闪烁

每张图集1254×1254。生成排布不是严格均分网格，manifest根据真实主体矩形定位，不直接按图宽除4裁切。每动作固定等比尺度、逐帧脚底锚点，避免帧宽变化让整只角色忽大忽小。这里只等比适配页面，不进行局部像素拉伸、骨骼或网格扭曲。

播放前全部fetch和createImageBitmap完成才启用按钮；切换源帧只从已解码图集裁切，不更换img.src、不逐帧联网。画布常驻，先在离屏画布画好完整帧，再一次copy提交，可见画布不先clear。动作内部直接换源图片帧，只有不同动作或恢复时进行100ms完整画面交接。

暂停保留可见帧，活动时钟停止；恢复从冻结画面衔接，清理旧排队指令。后台隐藏时不继续推进；长间隔最多推进64ms，避免恢复瞬间跳过旧动作。零尺寸保持画面，实际整数像素尺寸变化才重新分配画布。

| 动作 | 使用的不同源姿态 | 播放序列槽位 | 周期 |
| --- | ---: | ---: | ---: |
| 待机 / idle | 16 | 17 | 1600 ms |
| 眨眼 / blink | 16 | 17 | 800 ms |
| 挥爪 / wave | 16 | 17 | 1600 ms |
| 点头 / nod | 12 | 13 | 1600 ms |
| 摇头 / shake_head | 16 | 17 | 1600 ms |
| 伸懒腰 / stretch | 16 | 17 | 2000 ms |
| 开心 / happy | 12 | 23 | 1600 ms |
| 打盹 / sleep | 16 | 17 | 2400 ms |
| 摇尾 / wag_tail | 16 | 17 | 1200 ms |

序列最后回到首个中立帧；happy往返前12帧，nod回到首帧。实际源帧切换约5–21次/秒，取决于动作和中立帧重复；浏览器RAF频率和交接绘制次数不等于独立动画帧数。

## 与记忆服务的衔接

训练、正式对话继续使用既有API；后端动作建议交给PetMachine，机器狗实际播放周期使用SPRITE_DURATIONS，与manifest一致。训练仍需确认候选，正式对话保留真实MemoryOS引用。没有把原稿示例文案或素材说明写成用户记忆。

调试参数`?pet-debug=1`启用整张画布alpha检测，暴露源帧、绘制帧和空白计数；只用于验收，会增加读回成本。正式URL默认关闭像素诊断。

## 实现限制

九图集压缩合计约19MB，解码图像约57MB另加画布；首次加载需等待，并有20秒超时重试。生成素材外围有极低alpha噪点，实际浏览器检查没有明显杂斑。当前为二维预绘制动画，姿态自然度和生成细节仍受素材质量限制；采样没有整画布空白不代表无限时间、所有设备、所有局部像素绝对不闪。
