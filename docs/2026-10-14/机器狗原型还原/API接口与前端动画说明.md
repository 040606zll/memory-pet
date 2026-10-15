# 机器狗接口与前端动画说明

本轮修改位于独立项目 `/Volumes/ORICO/project/memory-pet`，保持左侧宠物房间、右侧训练与正式对话。没有改动MemoryOS核心、认证、环境文件、密钥、数据库或依赖，没有迁移或Git提交。

## 文件及影响

| 文件 | 改动与原因 |
| --- | --- |
| frontend/src/RobotDog.jsx | 原图与遮罩各加载一次、常驻画布、帧循环和主动按钮；暂停保留画面，恢复重新建立插值起点 |
| frontend/src/dogMotion.js | 原图坐标和动作时长，呼吸/眨眼/耳/尾及八动作；220ms从已显示姿态过渡 |
| frontend/src/dogRenderer.js | 原图RGB与alpha合成、共享网格局部变形、连续LED眨眼；尺寸守卫和真实GPU诊断 |
| frontend/src/App.jsx | 主体及头像接入机器狗；长气泡单行省略；保留真实MemoryOS引用与候选确认 |
| frontend/src/styles.css | 同主题机器狗房间、原图头像、三个动作按钮；手机气泡避眼、控件避脚 |
| frontend/src/petMachine.js | 新增wag_tail标签，沿用原排队和优先级逻辑 |
| frontend/src/main.jsx、frontend/index.html | 页面称谓改为机器狗 |
| frontend/public/assets/robot-dog-* | 原图、仅供alpha的抠图、独立背景、元数据 |
| frontend/tests/dogMotion.test.js、dogRenderer.test.js、robotDog.test.jsx | 连续姿态、绘图生命周期、暂停恢复回归 |
| frontend/tests/dog-visual.html | 开发用真实GPU原图/动作验收，不新增产品路由 |
| backend/pet/providers.py、schemas.py、actions.py | 机器狗人格、摇尾白名单/别名、否定及过去叙述保护；普通memory人格保持原行为 |
| tests/backend/test_machine_dog.py | 新增12项协议与记忆流程回归 |
| README.md、frontend/AGENTS.md、workspace与docs | 最新需求、使用说明、测试与验收证据 |

## 动画与接口

正式角色RGB只取用户原图 `robot-dog-reference.png`，生成抠图只取alpha，头像也取同一原图。WebGL2使用同一常驻纹理和共享三角网格，每帧只更新姿态，不用动作图片换帧，不逐帧重新渲染React。LED眨眼连续压缩原眼纹理。

动作时长由DOG.durations决定：blink800、wave2200、nod1600、shake_head1900、stretch3200、happy2400、sleep4800、wag_tail2200毫秒。按钮主动触发开心、眨眼和摇尾；语言及情绪动作使用同一队列；无人操作也会呼吸、眨眼、动耳和轻摆尾。

暂停不清画布，清除旧队列；恢复保留冻结pose，再220ms平滑衔接到闲置。零尺寸不清画布，只有有效整数尺寸实际变化时resize。普通页不每帧GPU读回，`?pet-debug=1`用于本地验收。

沿用已有连接、会话、聊天、候选及历史HTTP接口，没有新接口。动作新增 `{"name":"wag_tail","trigger":"explicit","duration_ms":2200}`，旧七动作兼容。训练候选经用户确认才写入；正式对话使用MemoryOS真实召回来源。`surface=memory`的普通助手无宠物动作。后端详细契约见同目录后端报告。

## 风险与边界

原图706×500，采用固定视角二维局部变形，不是完整三维骨骼模型。RGB来源完全相同，但生成背景与透明边缘不是原图逐像素复制，动态姿态也不可能与静态原稿每个像素相等。WebGL2失败显示中文重试提示。旧熊猫/Rive文件保留为历史，主宠物页不加载。
