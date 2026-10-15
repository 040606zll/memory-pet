# 机器狗记忆宠物

支持账号密码登录的宠物与记忆对话网页。前端使用 React、Vite 和预加载精灵图集的 Canvas 逐帧动画；后端使用 Python、FastAPI、LangChain Agent、httpx 和 MySQL 8。长期记忆由当前 MemoryOS 服务维护，训练与正式对话统一通过 LangChain `create_agent(...).ainvoke(...)` 生成回复与训练候选；候选仍须用户确认后才写入长期记忆。

## 当前访问地址

- 网页：http://127.0.0.1:8796/
- 后端健康检查：http://127.0.0.1:8797/api/health
- 本次联调的 MemoryOS：http://127.0.0.1:8863/health/ready
- 两张设计预览：网页地址加 `?preview=training` 或 `?preview=chat`。预览含明确标注的演示数据，不会写入记忆服务。

## 本机启动

需要 Python 3.11 或更高、Node.js 22 或更高和 pnpm。当前可使用已存在的 conda `xyd` 环境；安装依赖时须包含 SQLAlchemy、PyMySQL 和 Alembic。

第一次准备独立项目的依赖：

```bash
conda activate xyd
cd /Volumes/ORICO/project/memory-pet
python -m pip install -r backend/requirements.txt
cd frontend
pnpm install
```

MemoryOS 就绪后，先配置宠物后端。项目已提供 `backend/config.toml`，包含 `[llm]`、`[memoryos]` 和 `[mysql]`。建议复制到同目录 `config.local.toml` 后填写真实模型地址、密钥和模型名称；本机覆盖文件已加入 Git 忽略规则，不能打入公开发布包。启动时自动读取，修改后重启后端生效。

```bash
cp -n backend/config.toml backend/config.local.toml
chmod 600 backend/config.local.toml
```

MySQL 连接集中放在配置文件的 `[mysql]` 分组，由你自行填入真实信息；不要将密码放入前端或提交到仓库：

```toml
[mysql]
host = "127.0.0.1"
port = 3306
database = "memory_pet"
user = "memory_pet"
password = "" # 自行填写
```

先由管理员创建独立的全新 MySQL 数据库并授权。后端启动会使用 `backend/sql/mysql/005_mysql_store.sql` 创建 9 张缺失的业务表，不负责创建数据库或用户。连接失败时启动报中文错误，不会回退到 SQLite。现有 SQLite 文件和历史 SQL 保留，但运行时不读取、不迁移；新库需重新注册账号，不会自动认领旧聊天或 MemoryOS 用户映射。

各字段支持环境变量 `PET_MYSQL_HOST`、`PET_MYSQL_PORT`、`PET_MYSQL_DATABASE`、`PET_MYSQL_USER`、`PET_MYSQL_PASSWORD`。旧 `[storage]` 和 `PET_DATABASE` 已退出运行配置，请从本机覆盖文件与部署环境中移除旧存储项。生产迁移使用 `python -m alembic -c backend/alembic.ini upgrade head`，与应用读取同一套配置；完整建库、授权、备份和单 worker 部署步骤见 [部署指南](DEPLOY.md)。

优先级为“服务端环境变量 > `config.local.toml` > `config.toml`”。MemoryOS 地址、服务 API Key 和大模型均由管理员在后端配置，页面只填写账号密码。连接不检查 MemoryOS 的 profile 名称，按服务就绪状态及实际用户权限判断；当前账号按需创建并固定关联一个上游用户，后续登录复用。对外部署的 MemoryOS 仍须使用 `MEMORYOS_PROFILE=production`。

```bash
cd /Volumes/ORICO/project/memory-pet
./backend/start.sh
cd frontend
pnpm dev
```

`backend/start.sh` 通过脚本顶部固定的 `CONDA_BIN="/opt/anaconda3/bin/conda"`、`ENV_NAME="xyd"` 后台启动，并等待健康检查。部署到其他机器时直接修改这两项，不读取 `CONDA_EXE`、`PET_CONDA_ENV`，不自动搜索系统环境。无需先手动激活环境，可从任意工作目录调用脚本的完整路径。前台调试用 `./backend/start.sh run`。脚本不安装依赖、不修改应用配置，也不轮换 MemoryOS Key。后台 PID 和日志沿用 `.runtime/backend.pid`、`.runtime/backend.log`；8797 已占用时拒绝重复启动。更多说明见 `./backend/start.sh --help`。

后端可独立上传：后台模式调用同目录的 `start_service.py`，不再依赖项目根目录的 `scripts/start_backend.py`。部署时完整保留后端目录的 `start.sh`、`start_service.py`、`run.py`、`pet/`、`sql/` 及配置文件即可；日志和 PID 位于后端目录上一级的 `.runtime/`。进入后端目录也可直接运行 `./start.sh start`，不受部署目录层数影响。

后台服务可用 `./backend/start.sh stop` 停止、`./backend/start.sh restart` 重启、`./backend/start.sh status` 查看状态。停止前核对当前项目入口、Python 环境和进程启动时间，兼容旧版数字 PID；停止超过 15 秒会保留记录并取消重启，不强制结束进程。管理命令通过文件锁防止并发执行。`status` 运行返回 0，未运行返回 3，无法核验或命令失败返回 1。`run` 前台模式使用 Ctrl+C；systemd 托管的服务使用 systemctl。升级须同时替换两个启动文件并保留服务器顶部 Conda 配置，详见 [停止与重启说明](docs/2026-10-15/服务停止与重启/API接口文档.md)。

账号密码登录使用 HttpOnly、SameSite=Strict Cookie 和 CSRF 校验，登录有效期七天；密码只保存 scrypt 哈希。账号、登录会话及 `account_memory_bindings` 关联保存在宠物应用独立 MySQL 库，长期记忆仍由 MemoryOS 管理。一个服务 Key 可管理多个账号对应的独立上游用户，每个新用户占用一个上游用户额度。后端忽略旧全局 `MEMORYOS_USER_ID`，不自动认领旧会话或旧记忆。

前端调用宠物后端的地址统一放在 `frontend/src/config.js` 的 `API_BASE_URL`，打包前配置，重新打包后生效。当前值 `/pet-api` 在开发时由 Vite 改写为 `/api` 转发到 8797，部署时由 Nginx 同源转发。详见 [前端打包配置](DEPLOY.md#2-目录和依赖)。

`scripts/start_backend.py` 为历史单用户联调工具，可能创建或轮换上游 Key；当前账号版常规启动使用 `backend/start.sh`，不需要运行历史工具。

## 使用

1. 打开网页，创建账号或使用账号密码登录。MemoryOS 连接由系统处理；失败时“记忆服务”会显示原因并允许重试。
2. 在“训练”中告诉机器狗偏好或纠正回答。候选可以修改、拒绝，确认成功后才写入 MemoryOS。
3. 切换“正式对话”，机器狗调用真实召回结果回答；更换本地会话也能使用已确认的长期记忆。
4. 对它说“挥挥手，然后眨眨眼”，它会顺序执行。当前动作包括眨眼、挥手、点头、摇头、伸懒腰、开心微笑、打盹和摇尾巴。空闲时也会自主动作。
5. 菜单可以创建新对话、查看历史、暂停动作及开关语音播报。语音输入和播报依赖浏览器支持；没有麦克风权限时可正常文字聊天。

训练与正式对话各自保留会话、消息、草稿和重试状态。账号之间独立隔离；退出会卸载当前业务界面，旧账号的迟到响应不能进入下一账号。

## 验证

```bash
cd /Volumes/ORICO/project/memory-pet
python -m pytest tests/backend --cov=backend/pet --cov-report=term-missing --cov-fail-under=80
cd frontend
pnpm test:coverage
pnpm test:sites
pnpm build
```

真实 MySQL 业务测试需要通过安全配置提供 `PET_TEST_MYSQL_URL`，且只能指向明确授权的独立测试库；未配置时这些用例跳过，不能据此声称完整链路或 80% 整体覆盖率已通过。当前验证范围和数字见 [MySQL 测试报告](docs/2026-10-15/MySQL存储/测试报告.md)。

真实链路测试需要已配置的专用 MySQL 测试库、已启动的后端、可用模型和 MemoryOS，会向专属宠物测试用户写入明确标注的测试偏好，并生成不含 Key 的结果文件：

```bash
cd /Volumes/ORICO/project/memory-pet
python tests/live_chain.py
```

接口、测试、素材提示词和验收截图见 `docs/2026-10-14/熊猫宠物/`。模型拒绝、超时或空正文会显示中文错误，用户可以取消或重试；不会制造替代回复，也不会把未确认候选显示为已存记忆。

## 运行边界

本版已实现本地账号、登录会话和逐账号记忆隔离，运行时仅使用 MySQL，仍只启动一个 worker。请求互斥锁和启动恢复尚未通过跨进程验收，改用 MySQL 不代表可直接开启多 worker。后端默认只接受本机 Host/Origin，公网部署需要 HTTPS、准确的入口白名单以及生产模式 MemoryOS。无需为网页再配置 Nginx Basic 登录；额外入口保护可由管理员自行决定。本次不以历史联调结果作为当前服务状态，实际 MemoryOS 和模型连通性应在填齐配置后单独验收。

本次账号接口见 [账号密码登录文档](docs/2026-10-15/账号密码登录/API接口文档.md)，存储变更及验收边界见 [MySQL 存储文档](docs/2026-10-15/MySQL存储/API接口文档.md)。

## 机器狗外观与动画

最新版本使用同一角色的固定头部、躯干、爪子和尾巴，在加载阶段通过小幅刚性转动及平移烘焙完整图片帧，播放时一帧只绘制一张图片。没有网格形变、局部拉伸或两个不同姿态的透明叠加。眼睛使用真实眨眼源帧，头部其余毛纹固定。30Hz采样的重复姿态共享图集，当前170个不同图片帧，原生RGBA图集约67MiB；源图烘焙后立即释放。

训练/正式对话布局与记忆接口保持。按钮主动摸头、眨眼及摇尾，无操作时稀疏眨眼、偶尔摇尾。头像继续使用原稿机器狗。各动作起止和待机使用同一物理帧，暂停冻结，恢复沿图片帧回到中立。

GitHub参考：
- https://github.com/pixijs/pixijs/blob/dev/src/scene/sprite-animated/AnimatedSprite.ts
- https://github.com/phaserjs/phaser/blob/master/src/animations/AnimationState.js

当前说明见 `docs/2026-10-15/机器狗整帧闪动/`；`frontend/tests/dog-temporal-visual.html?coherent=1` 是生产Canvas路径的时序诊断页，检查连续帧、可见面积、亮度及单姿态输出一致性。旧网格、熊猫、Rive、v1多姿态图集和旧诊断页只保留历史。当前为小幅二维部件动作，完整身体舒展和三维转头仍需专门动画素材，不能称为真实视频级自然度。

### 持续抽动修正（2026-10-15）

历史的DogFramePainter局部混合版本虽然静止脚部ROI通过，用户仍观察到严重抽动；完整连续帧证实头部出现双脸重影。因此该版本的视觉通过结论撤回，当前播放器不再使用该合成器。DogBehavior的稀疏自主动作节奏保留。

旧报告docs/2026-10-15/宠物动作持续抽动/仅用于追溯，不能把该轮像素检查或覆盖率当作当前画面自然度保证。
