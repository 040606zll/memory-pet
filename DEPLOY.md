# memory-pet 部署指南

更新日期：2026-10-15。适用于当前机器狗宠物页 `/` 和普通记忆对话页 `/memory`。这两个页面属于同一个项目，共用一个 FastAPI 后端；上游长期记忆由独立 MemoryOS 项目管理。

本文提供可按当前代码落地的 **Linux 部署（账号密码登录，单 worker）**：构建后的静态网页由 Nginx 在回环地址提供，FastAPI 由 systemd 监管，使用者通过 SSH 隧道访问。MemoryOS 的生产部署另见其项目 `docs/operations/MemoryOS与宠物项目部署指南.md`。

## 1. 当前版本的边界

部署前明确以下现状，不能把本机原型当成匿名公网多租户服务：

- `backend/pet/main.py` 中 `AccessMiddleware` 默认只接受本机 Host 和 Origin；现在可通过 `[server]` 精确白名单允许指定 IP 或完整域名。账号版入口使用文末登录说明与 `backend/deploy/nginx-public.conf.example`；旧公网403说明仅供历史追溯。未配置白名单时直接用公网域名反代仍返回 403。
- 浏览器使用本项目账号密码登录，HttpOnly Cookie 与 CSRF 保护会话；服务 Key 由后端统一管理，每个本地账号固定关联独立的 MemoryOS 用户。
- 运行时仅连接独立 MySQL 8 数据库，没有 SQLite 回退；本次采用全新库，不迁移旧 SQLite 数据。连接信息由管理员后续填写。
- 账号、消息和记忆已按登录账号隔离；进程内请求互斥锁及启动恢复仍未完成跨进程验收，本版必须使用 **1 个 worker**，不能因切换 MySQL 直接开启多进程。
- 输入只允许文字；回复朗读仍是可选输出能力。训练与正式对话分别保存会话、消息、草稿和重试状态。

本方案不修改本机访问限制，通过 SSH 保持浏览器访问地址为本机 URL。不要通过清空 Origin／Sec-Fetch-Site 或伪造回环 Host 将匿名公网请求包装成本机请求。

## 2. 目录和依赖

假定发布包已放在 `/srv/memory-pet`，创建普通系统用户 `memorypet` 运行后端；Nginx 用户需有读取构建产物的权限。

需要 Python ≥3.11、Node 22.12 或更高的 22.x、pnpm。本文复用部署服务器 Conda `xyd`，systemd 中 Python 路径示例为 `/opt/miniconda3/envs/xyd/bin/python`，根据 `command -v python` 的真实结果替换。

打包前检查 `frontend/src/config.js` 中的宠物后端 API 地址：

```js
export const API_BASE_URL = '/pet-api';
```

本指南采用同源代理，浏览器请求当前站点的 `/pet-api`，Nginx 和 Vite 将其改写至后端 `/api`。浏览器无需填写后端地址，也不直接访问服务器回环地址。

此配置由 `src/api.js` 统一读取，编译进前端 JS。若部署入口有其他前缀，例如 `/pet-api`，须在打包前将常量改为对应路径，并让反向代理映射到宠物后端的 `/api`；修改后重新打包并部署完整 `dist/client`。仅修改服务器进程环境不会改变已打包前端。

使用 `API_BASE_URL = '/pet-api'` 时，开发环境的 Vite 代理必须重写路径；只将代理键名改为 `/pet-api` 会把错误前缀原样传给后端。`frontend/vite.config.mjs` 的 `server.proxy` 对应写法如下，修改后重启 Vite：

```js
proxy: {
  '/pet-api': {
    target: 'http://127.0.0.1:8797',
    rewrite: (path) => path.replace(/^\/pet-api(?=\/|$)/, '/api'),
  },
},
```

打包部署时，将第 5 节 Nginx 的 `location /api/` 替换为下面这一段。`proxy_pass` 的 `/api/` 和末尾斜线必须保留，使 `/pet-api/health` 转发为 `/api/health`；后端路由无需修改。

```nginx
location /pet-api/ {
    proxy_pass http://127.0.0.1:8797/api/;
    proxy_set_header Host $proxy_host;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

上线前用 `nginx -t` 检查，再重新加载 Nginx，并通过网页入口的 `/pet-api/health` 验证，不能只验证直连后端的 `/api/health`。这是同源路径映射，不改变下述本机 Host／Origin 限制。

独立域名形式可写为 `https://pet-api.example.com/api`，但当前后端没有跨域 CORS 配置，**当前版本不能仅靠改这个常量部署为跨域公网服务**；新增部署白名单不会开启 CORS。本指南保持 `/api` 同源方案，公网 `/pet-api` 同源入口另见上方更新步骤。该文件属于公开前端配置，禁止写入模型或 MemoryOS 密钥。

```bash
conda activate xyd
cd /srv/memory-pet
python -m pip install -r backend/requirements.txt
cd frontend
pnpm install --frozen-lockfile
pnpm build
```

本项目实际构建产物是 **`frontend/dist/client`**，不是 MemoryOS 的 `frontend/dist`。整个 `client` 目录都要部署，包含 assets、动画素材和懒加载分包。

`pnpm build` 同时生成 `dist/server/index.js` 和 `dist/.openai/hosting.json`，用于既有 Sites 静态托管兼容流程。该 Worker 只处理静态资源和 SPA 回退，**没有实现 Python 后端或 `/api` 代理**；只上传静态产物无法完成记忆对话。

发布包不包含开发机 `.runtime/`、`backend/config.local.toml`、凭据、node_modules 和测试数据。`backend/config.toml` 只保留无真实密钥的默认值。旧 SQLite 文件和历史 SQL 可另外归档；当前运行时不读取、不导入这些数据。MySQL 备份见第 8 节。

## 3. 配置上游服务和 MySQL

先按另一份指南启动 MemoryOS，确认 `/health/ready` 为 ready、`/health/worker` 可用，并启用严格鉴权，再从 MemoryOS 管理后台取得专属 API Key。不要将管理员 token 当成业务 API Key。必须启用 `MEMORYOS_PROFILE=production`；服务 Key 需有为新账号创建用户的剩余额度。旧全局用户 UUID 不用于账号映射。

### 项目内配置文件

已提供 `backend/config.toml`，应用启动自动读取同目录可选的 `config.local.toml`，无需手工加载配置或改启动工作目录。开发环境可在项目根目录复制并编辑：

```bash
cp -n backend/config.toml backend/config.local.toml
chmod 600 backend/config.local.toml
```

本机文件可只写需要覆盖的字段，例如：

```toml
[llm]
base_url = "https://供应商地址/v1"
api_key = "替换为实际模型密钥"
model = "替换为实际模型名称"

[memoryos]
base_url = "http://127.0.0.1:8863"
api_key = "替换为MemoryOS业务密钥"
user_id = "" # 历史配置不作为账号映射依据；各账号独立创建并保存映射

[mysql]
host = "127.0.0.1"
port = 3306
database = "memory_pet"
user = "memory_pet"
password = "" # 自行填写真实密码
```

优先级为 **进程环境变量 > `config.local.toml` > `config.toml`**。环境变量存在但值为空时也会覆盖文件；已有 `LLM_*` 环境配置时，单改文件不会生效。MySQL 的 port 可填写 TOML 整数或数字字符串，其余连接字段使用文本。TOML 格式错误、未知字段或不支持的值类型会阻止启动并给出中文提示，不回显配置内容。旧 `[storage]` 分组已移除，`PET_DATABASE` 不再决定存储位置。

`config.local.toml` 已被 Git 忽略，但仍需按密钥保护；不允许上传到公开发布包或放入前端目录。修改后重启后端，不需要重新打包前端。

### 新 MySQL 库准备与生产迁移

管理员先在 MySQL 8 中创建专用数据库和数据库用户，禁止复用 MemoryOS 业务库。以下是待自行替换的示例，不包含可用密码，也不会由应用自动执行：

```sql
CREATE DATABASE memory_pet CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'memory_pet'@'127.0.0.1' IDENTIFIED BY '<自行设置MySQL密码>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX
    ON memory_pet.* TO 'memory_pet'@'127.0.0.1';
```

用户的来源地址须匹配 MySQL 实际看到的连接来源；远程数据库填写内网地址并由管理员配置网络访问。应用固定使用 utf8mb4，9 张表均为 InnoDB、使用逻辑关联；地址摘要索引避免超长 URL 导致索引超限。

配置 `[mysql]` 后，可在应用同一环境、同一套配置下执行生产迁移：

```bash
cd /srv/memory-pet
python -m alembic -c backend/alembic.ini upgrade head
```

迁移入口复用应用配置。若真实连接只保存在 systemd 的 EnvironmentFile，普通终端命令不会自动加载该文件，需由运维使用相同环境运行迁移；不要把包含密码的 URL 粘贴到命令行。历史迁移会在线检查列与索引，不支持不做结构检查的离线 SQL 模式。新库也可由首次启动创建 9 张缺失表；生产使用 Alembic 可记录版本。连接失败时启动终止并提示中文错误，不会创建 SQLite 文件或读取旧库。

### Linux 生产环境变量配置

下面保留 systemd EnvironmentFile 方案，可在不创建本机 TOML 文件的情况下使用，也能覆盖项目默认文件。服务器部署建议将真实密钥独立保存在 `/etc/memory-pet/pet.env`，不随代码更新。

由运维创建下列路径，并确保文件归属和权限正确：

```bash
sudo install -d -m 700 /etc/memory-pet
sudo install -m 600 /dev/null /etc/memory-pet/pet.env
sudoedit /etc/memory-pet/pet.env
```

将以下内容填入该**服务端配置文件**；所有尖括号占位项必须替换。不要创建 `VITE_*_KEY`，不要写入前端：

```ini
MEMORYOS_BASE_URL=http://127.0.0.1:8863
MEMORYOS_API_KEY=<专属MemoryOS业务APIKey>
MEMORYOS_USER_ID=
LLM_BASE_URL=<兼容ChatCompletions的实际基础地址>
LLM_API_KEY=<实际模型APIKey>
LLM_MODEL=<实际模型名称>
PET_MYSQL_HOST=127.0.0.1
PET_MYSQL_PORT=3306
PET_MYSQL_DATABASE=memory_pet
PET_MYSQL_USER=memory_pet
PET_MYSQL_PASSWORD=<实际MySQL密码>
```

配置文件使用 systemd EnvironmentFile 的 `变量=值` 格式，不写 `export`，不依赖 Shell 的变量展开。包含空格等特殊内容时按 EnvironmentFile 规则加引号。

地址填写规则：

| 上游 | 填写方式 |
| --- | --- |
| 同服务器 MemoryOS | `http://127.0.0.1:8863`，直连后端，不加 `/api` |
| 另一服务器，按联合指南的 Nginx 部署 | `https://memory.example.com/api`，此时 `/api` 是公网反代前缀 |
| 容器中的本项目 | 容器内 localhost 指向自身，需改为实际可达的内网服务地址；本文主方案使用宿主机进程 |
| LLM | 后端会在基础地址后拼接 `/chat/completions`；兼容端点需要 `/v1` 时把它包含在基础地址中，也可填写完整 `/chat/completions` 地址 |

模型必须支持 JSON 对象输出以及当前 reply/emotion/actions/candidates 契约；模型名字以你实际有权限调用的型号为准。服务器必须能够访问 MemoryOS 和模型供应商。

大模型仅由宠物后端从配置文件或环境读取，页面没有模型配置入口，接口也拒绝客户端提交模型配置。修改后执行 `sudo systemctl restart memory-pet`；地址、密钥或模型名缺失时，连接会提示管理员配置后重启。

环境文件让重启后恢复服务配置。MemoryOS 和模型配置只由后端管理，网页不再填写 Key；账号用户映射和登录会话保存在 MySQL，服务重启后仍可复用。

## 4. 后端启动

### 使用 Conda 脚本直接启动

依赖安装和第 3 节后端配置完成后，可使用项目提供的脚本：

```bash
cd /srv/memory-pet
./backend/start.sh
```

部署前直接编辑 `backend/start.sh` 顶部两项固定配置，例如 Linux 服务器可填写：

```bash
CONDA_BIN="/opt/miniconda3/bin/conda"
ENV_NAME="xyd"
```

仓库当前路径为开发机的 `/opt/anaconda3/bin/conda`，部署时须换成服务器的实际路径。脚本不读取 `CONDA_EXE`、`PET_CONDA_ENV`，也不自动搜索系统环境。不要求手动执行 `conda activate`；只运行宠物后端，不启动 MemoryOS、前端，也不创建或轮换 Key。启动前检查 8797 端口，通过 `/api/health` 检查后才报告启动成功。PID 写入 `.runtime/backend.pid`，日志追加至 `.runtime/backend.log`。应用配置优先级仍为环境变量 > `config.local.toml` > `config.toml`，此项与脚本固定的 Conda 选择无关。

```bash
# 后台服务管理（也可进入实际后端目录后使用 ./start.sh）。
./backend/start.sh status
./backend/start.sh stop
./backend/start.sh restart
# 前台调试；不要与后台模式或 systemd 重复启动。
./backend/start.sh run
# 查看帮助，不启动服务。
./backend/start.sh --help
```

如果发布工具未保留执行权限，可用 `bash backend/start.sh`。后台模式使用同目录的 `backend/start_service.py`，不依赖项目根目录的 `scripts/`，仅上传完整后端目录也可以运行。进入该后端目录后执行 `./start.sh start` 即可；不要仅更新 Shell 脚本而漏传 `start_service.py`。日志及 PID 位于后端目录上一级的 `.runtime/`，启动超时或失败时只清理本次启动的子进程。

后台模式支持 `start`、`stop`、`restart`、`status`。停止前核验 PID 对应的当前项目入口、Python 环境及已记录启动时间；兼容旧版仅含数字的 PID 文件，但无法核验的 PID、其他进程和没有运行记录的端口占用都拒绝接管。新启动会额外写入 `.runtime/backend-process.json`；管理锁位于 `.runtime/backend.lock`。停止只发送 SIGTERM，最多等待 15 秒，超时保留记录并取消重启；不会自动强制终止。停止成功保留日志、配置和数据库，只移除运行记录。`status` 返回值为运行 0、未运行 3、异常 1，不代表上游连接状态。

升级时同时替换 `start.sh`、`start_service.py`，保留服务器原有 `CONDA_BIN` 与 `ENV_NAME`（本服务器为 `memory`）。若升级时修改了 Python 环境或移动了后端目录，旧进程可能无法通过归属核验，应在修改前先使用原配置停止服务。不要手动删除仍在使用的 PID 或启动记录。前台 `run` 未记录受管 PID，用 Ctrl+C 停止。`/api/health` 成功只代表宠物进程正常，不表示上游模型和 MemoryOS 已连接；账号版重启后按 MySQL 映射恢复，无需用户填写 Key。长期运行的 Linux 服务建议采用下方 systemd 方案，由系统负责退出后恢复和停止管理；两种方式选择一种，systemd 托管时不要再使用脚本 stop/restart。

### 使用 systemd 管理后端服务

由运维将下面内容保存为 `/etc/systemd/system/memory-pet.service`：

```ini
[Unit]
Description=Memory pet single-user API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=memorypet
Group=memorypet
WorkingDirectory=/srv/memory-pet/backend
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=/etc/memory-pet/pet.env
ExecStart=/opt/miniconda3/envs/xyd/bin/python -m uvicorn pet.main:app --host 127.0.0.1 --port 8797 --workers 1 --no-access-log
Restart=on-failure
RestartSec=5
TimeoutStopSec=180
UMask=0077

[Install]
WantedBy=multi-user.target
```

`pet.main:app` 依赖工作目录 `/srv/memory-pet/backend`；不要直接照搬 MemoryOS 的 `backend.api.main:app`。启动前确认运行用户能读取源码、Python 环境和应用 TOML 配置，并能连接 MySQL。数据库文件由 MySQL 服务管理，宠物进程不再需要 `/var/lib/memory-pet` 作为数据库可写目录。systemd 的此启动方式使用 journal 日志；只有另行采用 Conda 后台脚本时，才需要允许运行用户写入后端上一级 `.runtime/` 目录存放 PID 和日志。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now memory-pet
sudo systemctl status memory-pet --no-pager
curl --fail http://127.0.0.1:8797/api/health
curl -i http://127.0.0.1:8797/api/auth/me  # 未登录应为 401
```

`/api/health` 只说明宠物进程存活。业务状态接口需要登录，未登录访问应为 401；登录后在网页检查记忆服务状态，不能以进程健康检查替代上游验证。

本方案不运行 `scripts/start_backend.py`，也不与该脚本重复启动。其 `--memoryos-project` 是本机联调辅助，可能创建／轮换专属 Key，不应作为每次服务器重启的生产入口。

## 5. Nginx 静态站点和同源 API

将下面内容保存到 Nginx 的 http 配置包含目录，例如 `/etc/nginx/conf.d/memory-pet-private.conf`：

```nginx
server {
    # 保持回环监听，使用 SSH 隧道访问，8796 不向公网开放。
    listen 127.0.0.1:8796;
    server_name localhost 127.0.0.1;
    root /srv/memory-pet/frontend/dist/client;
    index index.html;
    client_max_body_size 1m;

    location /pet-api/ {
        # 用 /api/ 替换公开前缀：/pet-api/auth/me → 后端 /api/auth/me。
        proxy_pass http://127.0.0.1:8797/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $proxy_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /assets/ {
        try_files $uri =404;
        # 原始动画素材可能沿用文件名，更新后需要重新验证缓存。
        add_header Cache-Control "no-cache";
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }
}
```

两个项目的前缀处理不同：MemoryOS 站点去掉其公开 `/api`；宠物站点将 `/pet-api/` 改写为后端 `/api/`。依据 [Nginx proxy_pass 官方说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass) 区分末尾斜线。Origin 保持浏览器原值，由现有本机校验继续检查；此配置只用于回环监听。

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail http://127.0.0.1:8796/pet-api/health
curl --fail http://127.0.0.1:8796/memory
```

第二条应返回页面 HTML。SPA 回退保证 `/memory` 刷新可用；不存在的静态资源应返回 404，不能把 HTML 当图片或 JS 返回。

这里使用构建产物，生产无需启动 Vite，也无需 Node 常驻。当前开发配置中的 Vite `/api` 代理不会自动出现在静态托管环境。

## 6. 使用者通过 SSH 访问

在**自己的电脑**执行，替换 SSH 登录用户和服务器地址；SSH 服务需允许本地端口转发：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8796:127.0.0.1:8796 deploy@server.example.com
```

保持该 SSH 连接运行，浏览器打开：

- 宠物页：`http://127.0.0.1:8796/`
- 普通记忆页：`http://127.0.0.1:8796/memory`

如果你电脑的 8796 已被开发服务占用，将命令中的本地端口改成 18796，例如 `-L 127.0.0.1:18796:127.0.0.1:8796`，然后使用浏览器 `http://127.0.0.1:18796`。Origin 本机检查允许这种端口变化。

访问入口由 SSH 身份校验和加密保护，服务器不开放 8796／8797。浏览器看到的 localhost 经隧道连接服务器，不会调用你电脑的旧后端。

网页先创建账号或登录，系统按当前账号建立并复用独立 MemoryOS 用户。页面“记忆服务”只显示状态与重试按钮，不接受上游地址、Key 或 UUID。连接检查不额外生成模型问候；实际对话才调用模型。

MySQL 中持久化 `local_accounts`、`login_sessions`、`account_memory_bindings`、`login_attempts` 及消息等 9 张表。完整备份此独立应用库可保存账号、登录状态、聊天和映射；本次新库不接入旧 SQLite 账号，需重新注册，旧全局会话也不自动分配。密码只保存 scrypt 哈希，登录凭据只保存 SHA-256 摘要。全量建表 SQL 为 `backend/sql/mysql/005_mysql_store.sql`，生产迁移链到 `20261015_005_mysql_store.py`。真实 MySQL 全链路仍需专用数据库配置后验收。

Cookie 作用于整个同源站点，HTTPS 请求自动启用 Secure。Nginx 必须保留 `X-Forwarded-Proto`，Uvicorn 只信任实际反向代理。公网请使用独立站点域名；不要与不受信任应用共用同源目录。示例 `backend/deploy/nginx-public.conf.example` 使用 `/pet-api/` 到后端 `/api/` 的代理，不再要求站点 Basic 密码。

项目连接流程不校验 MemoryOS 的 profile 名称，按就绪状态及实际用户权限判断，仍需要有效业务 Key；对外部署 MemoryOS 必须使用 production 模式。服务失败只影响记忆连接，不阻断本地登录；重试使用固定账号标记恢复已创建用户。MySQL 短事务和账号初始化租约用于协调绑定，仍保留单 worker；启动恢复与请求锁尚未完成多进程、多副本验收。账号流程详见 [账号密码登录](docs/2026-10-15/账号密码登录/API接口文档.md)。

## 7. 部署验收

1. 本项目 `/api/health` 200；MemoryOS ready 和 worker 均正常。
2. 浏览器两个页面均能打开，`/memory` 刷新不 404，机器狗素材能加载。
3. 训练与正式对话均没有麦克风，文字发送、Enter 发送和 Shift+Enter 换行可用。
4. 在独立验收用户下发送明确偏好，检查候选后确认，只有获得真实记忆编号才视为写入成功。
5. 切换正式对话：训练正文／候选不带入；正式对话发送后拥有独立会话编号，切回训练恢复原消息。
6. 新建正式会话，询问先前确认的偏好，检查真实 MemoryOS 引用，不能只用同会话上下文证明长期记忆。
7. 普通页写入／召回按同样方式验收，且历史与宠物页隔离。
8. 重启本项目：MySQL 账号、映射和历史仍存在；从历史列表重开会话，重新验证连接后可继续。未发送草稿只在当前页面内保存，不承诺刷新后恢复。

步骤 4～6 会产生模型调用和测试记忆，应使用专属测试 Key／用户，不往正式用户写测试内容。

可在候选发布包执行自动化检查：

```bash
cd /srv/memory-pet
python -m pytest tests/backend
cd frontend
pnpm test
pnpm test:sites
pnpm build
```

`test:sites` 只验证静态 Worker 行为，不代表完整 Python 后端已部署。

真实 MySQL 业务自动化需通过安全配置提供 `PET_TEST_MYSQL_URL`，指向明确授权的独立测试库；缺少该项时用例会跳过，不能视为 MySQL 集成通过。本次未提供专用测试连接，完整链路及整体覆盖率仍待补充，当前数字见 [MySQL 测试报告](docs/2026-10-15/MySQL存储/测试报告.md)。

## 8. 备份、迁移和更新

### 8.1 MySQL 备份

备份应连接宠物项目独立数据库，不要对 MemoryOS 数据库执行下列操作。先使用 MySQL 客户端的 `mysql_config_editor set --login-path=memory-pet --host=<主机> --user=<备份用户> --password` 交互保存凭据，避免密码出现在命令行与 Shell 历史；备份用户权限由管理员单独配置。

```bash
umask 077
mkdir -p /var/backups/memory-pet
mysqldump --login-path=memory-pet --single-transaction \
  --no-tablespaces --skip-lock-tables memory_pet \
  > /var/backups/memory-pet/pet-$(date +%Y%m%d-%H%M%S).sql
```

替换示例库名，并在运行结束后确认退出码为 0、备份完整。`--single-transaction` 面向 InnoDB 的一致性快照，备份期间不要执行 DDL。目录应由专用备份用户持有并限制其他用户读取；systemd 应用运行用户不需要访问备份目录。

备份包含账号密码哈希、有效登录会话、用户映射、消息、候选及幂等状态，应按敏感数据保护；不包含 MemoryOS 长期记忆。MemoryOS 需要独立备份；环境配置和 API Key 通过密钥备份流程另存，不能打进公开发布包。恢复须停掉宠物应用并在管理员核对目标库后进行，先在独立恢复库验证，禁止将演示命令直接覆盖现用库。

本次用户选择全新 MySQL 库，旧 SQLite 文件和历史 SQL 仅保留归档，不迁移、不读入，也不作为 MySQL 故障回退。旧账号、聊天和 MemoryOS 用户映射不会自动出现在新库中。新库重新注册账号后，由正常连接流程建立独立 MemoryOS 用户。

账号版历史 scope 包含本地账号 ID 和 MemoryOS 基础地址，更改服务地址可能使原历史暂不可见。API Key 正常轮换本身不会改变 scope；后续 MySQL 到 MySQL 迁移若同时变更服务地址，应另外规划映射处理。

### 8.2 更新与回滚

1. 保留旧代码和前端发布包，备份 MySQL 和服务器配置；首次切换的旧 SQLite 文件单独归档，不导入新库。
2. 在候选目录更新代码、按锁文件安装并构建；只有依赖变化才重新安装后端依赖。
3. 停止 `memory-pet`，切换代码及完整 `dist/client` 产物；保留 MySQL 数据和配置文件，必要时先执行匹配版本的 Alembic 迁移。
4. 启动服务，检查 health，浏览器重新完成连接验证，再验收模式隔离和跨会话召回。
5. 仅当数据库结构与旧版本兼容时切回旧代码；涉及数据结构变化则需要匹配的数据库恢复方案，不能用空库代替回滚。

```bash
sudo systemctl restart memory-pet
sudo journalctl -u memory-pet -n 100 --no-pager
```

新 MySQL 库启动时自动执行幂等基线创建缺失表；生产升级应使用 `backend/alembic.ini` 明确执行并记录迁移版本，不能把 `CREATE TABLE IF NOT EXISTS` 当作旧表结构升级。005 检测到旧绑定表结构不兼容时会要求全新空库，不擅自转换或删除旧数据。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| 公网域名访问 API 403 | 核对 `[server]` 中精确的 Host 和 Origin 白名单；必须先保护公网入口，或继续用本文 SSH 方案，不改头部绕过 |
| 502／连接拒绝 | 检查 systemd、8797 监听、Nginx 代理和工作目录 |
| health 成功仍显示未连接 | health 不代表上游已验证；打开“记忆服务”查看原因并重试 |
| 记忆服务提示凭据无效 | 由管理员检查服务端 Key、权限和 production 模式；普通用户不填写 Key |
| 提示后端未配置完整的大模型服务 | 在宠物后端配置文件或 EnvironmentFile 填齐模型三项并重启；检查环境变量是否覆盖文件；页面不能配置模型 |
| 提示 MemoryOS 用户目录未启用鉴权 | 启用 MemoryOS 强制鉴权；公网部署使用 production；不能在目录全站可见时自动绑定 |
| 自动建号提示额度不足 | 在 MemoryOS 管理端核查该 Key 配额；不反复创建，不静默切换其他 Key 或用户 |
| 多进程时配置时有时无 | 本版必须单 worker，各进程不会共享内存配置和互斥锁 |
| 网页正常但训练／召回 404 | `/api` 被误删，或者只部署了 Sites 静态 Worker |
| `/memory` 刷新 404 | Nginx 未设置 SPA 回退，或 root 指向 dist 而非 dist/client |
| 头像正常、动作素材失败 | 发布包缺少 public 对应的构建资产，或资产请求返回 HTML |
| 历史突然空白 | 核对登录账号、MySQL 主机和库名、服务地址；此次新库不导入旧 SQLite 历史，旧单用户历史也不会自动分配给新账号 |
| 启动提示 MySQL 暂不可用 | 检查 `[mysql]`、同目录覆盖文件及 PET_MYSQL_* 环境变量，确认数据库已创建、已授权且网络可达；不会自动回退 SQLite |
| 记忆没有生成有效编号 | 检查 MemoryOS 是否提取出明确事实、是否存在冲突，不能伪造成功 |

## 10. 公网部署边界

本次已实现账号密码登录、Cookie/CSRF、按账号固定的 MemoryOS 用户和业务隔离。公开注册会消耗上游用户额度，当前没有邮箱验证、邀请制、找回密码或后台账号管理；对外开放注册前应按业务需求补充。当前 MySQL 版本仍限制单 worker，多进程和多副本需进一步验证启动恢复、请求锁、配额与运维策略。

本文未在目标 Linux 机器执行安装、域名或 HTTPS 验收，不能把本地模板检查当成已上线。
