# API接口与动画说明

本次仅修复宠物画面，后端接口、训练和正式对话协议、认证、记忆写入与召回均无变更，不增加API。

| 文件 | 改动与原因 |
| --- | --- |
| frontend/src/dogFrameAtlas.js | 新增同一角色刚性部件帧烘焙。30Hz采样、相同姿态共享物理帧、加载阶段全部完成，再交付播放器；消除不同姿态脸部透明混合。 |
| frontend/src/dogSpriteAssets.js | 加载函数支持only选项；正式页面只读取blink源图，旧默认行为保留。 |
| frontend/src/dogSpritePlayer.js | 单张完整帧裁切提交；删除相邻姿态淡化、动作交叉淡化及DogFramePainter调用。恢复时通过原有帧回中立。 |
| frontend/src/RobotDog.jsx | 使用新素材准备函数，显示coherent-v2及帧资源诊断标记；刷新间隔按RAF计算，避免把安静时不重绘误报为掉帧。 |
| frontend/tests/dogFrameAtlas.test.js | 新增端点、速度、内存去重、资源释放、取消与解码失败测试。 |
| frontend/tests/dogSpritePlayer.test.js、dogContinuity.test.js、robotDog.test.jsx | 回归单帧输出、无透明中间图、暂停恢复及组件生命周期。 |
| frontend/tests/dog-temporal-visual.html | 真实Canvas整帧时序诊断，涵盖八动作及输出与选定图片的一致性。 |
| README.md、frontend/AGENTS.md、design-qa.md | 更正先前不充分的视觉验收结论，记录禁止恢复双脸淡化的要求。 |

素材流程：读取并解码blink图集→固定中立角色部件→同尺寸、同锚点、刚性转动/平移烘焙→去重共享图集→释放源图→常驻Canvas逐帧裁切。没有局部宽高缩放、网格或形变。

当前170个独立图片帧，RGBA图集70,197,248字节（约67MiB）。首尾和待机直接引用同一图集位置。加载失败保持中文重试入口，未完成前不启用动作按钮。

参考PixiJS AnimatedSprite按当前整数帧直接更新纹理的机制，没有安装或复制依赖：[官方实现](https://github.com/pixijs/pixijs/blob/dev/src/scene/sprite-animated/AnimatedSprite.ts)。帧烘焙及行为节奏为本项目实现。

风险与边界：首次加载需要生成图集，低内存设备需关注约67MiB解码常驻开销；当前是小幅二维部件动作，不能描述为真实三维或完整身体舒展。未改共享PetMachine、后端、密钥、依赖和构建配置，未发布或提交Git。
