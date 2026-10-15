# MySQL 存储接口与部署说明

日期：2026-10-15。适用项目：memory-pet。

## 需求边界

账号、登录状态、MemoryOS 用户映射、会话、消息、训练候选及请求幂等状态统一改为 MySQL 持久化。用户选择全新 MySQL 库，连接信息由用户后续配置；不迁移旧 SQLite 数据，不删除旧 SQLite 文件和历史 SQL，运行时无 SQLite 回退。长期记忆仍通过 MemoryOS 接口管理。

本次不改变前端请求路径、账号密码登录方式、Cookie/CSRF 和业务响应结构，不增加数据库管理 HTTP 接口。MySQL 替换不等于多进程验收完成，当前继续使用单 worker。

## 配置

`backend/config.toml` 提供默认分组，同目录 `config.local.toml` 可仅覆盖所需字段。优先级：进程环境变量 > config.local.toml > config.toml。真实密码不得写入前端、公开示例或公开发布包。

```toml
[mysql]
host = "127.0.0.1"
port = 3306
database = "memory_pet"
user = "memory_pet"
password = "" # 自行配置
```

| 配置项 | 环境变量 | 说明 |
| --- | --- | --- |
| mysql.host | PET_MYSQL_HOST | 实际可达的数据库主机 |
| mysql.port | PET_MYSQL_PORT | 数据库端口，默认 3306；TOML 可为整数或数字字符串 |
| mysql.database | PET_MYSQL_DATABASE | 独立应用库，默认 memory_pet；先由管理员建库 |
| mysql.user | PET_MYSQL_USER | 已授权的 MySQL 用户 |
| mysql.password | PET_MYSQL_PASSWORD | 用户自行填写的真实密码 |

连接固定使用 utf8mb4。旧 `[storage]` 分组不再有效；`PET_DATABASE` 不再决定数据库位置。修改配置后重启后端，无须重新构建前端。无效配置、不可达数据库或缺少建表权限会导致启动失败，不会切回 SQLite。

## 初始化和生产迁移

管理员先建立专用 MySQL 8 数据库并授权，不能复用 MemoryOS 数据库。后端启动读取 `backend/sql/mysql/005_mysql_store.sql`，逐条创建缺失的 9 张业务表。所有关联均为逻辑关联，没有物理外键；标识符大小写敏感，正文支持中文与 emoji。

| 表名 | 用途 |
| --- | --- |
| sessions | 登录账号作用域内的训练、正式及普通页面会话 |
| messages | 消息正文和结构化响应 |
| candidates | 待确认训练记忆及确认结果 |
| operations | 聊天和确认请求幂等状态 |
| memory_user_bindings | 保留的历史 Key 与用户映射结构 |
| local_accounts | 账号与 scrypt 密码哈希 |
| login_sessions | 登录令牌摘要、CSRF 与过期时间 |
| account_memory_bindings | 账号与 MemoryOS 用户绑定及初始化租约 |
| login_attempts | 登录失败次数与限流过期信息 |

两类绑定使用 `BINARY(32)` 地址摘要参与业务主键，写入 SQL 使用 `UNHEX(SHA2(service_url,256))` 计算；保留完整服务地址进行归属查询，不直接为 2048 字符地址建立复合索引。

生产迁移入口为 `backend/alembic.ini`，与应用读取相同配置：

```bash
python -m alembic -c backend/alembic.ini upgrade head
```

历史 001 迁移按数据库方言选择 SQL，链末为 `20261015_005`。005 对已存在的绑定表检查摘要列、业务主键和地址长度；发现旧结构则提示使用全新空库，不自动转换或删除旧数据。离线模式不能完成必要结构检查，暂不支持。单独 `CREATE TABLE IF NOT EXISTS` 仅创建缺失表，不能替代旧表升级。

## HTTP 调用与数据影响

接口统一为 `{code, message, data}`，错误使用中文，认证仍使用 `memory_pet_session` Cookie；修改请求保留 `X-CSRF-Token`。下表中的后端前缀为 `/api`，网页使用的 `/pet-api` 由同源代理映射。

| 接口 | MySQL 读写 | 其他服务调用 |
| --- | --- | --- |
| POST /api/auth/register | 创建账号与登录会话 | 不依赖 MemoryOS 建号成功 |
| POST /api/auth/login | 查询账号、验证密码、保存登录会话、更新限流 | 无模型调用 |
| GET /api/auth/me | 查询有效登录会话与账号 | 无 |
| POST /api/auth/logout | 删除当前登录会话 | 无 |
| GET /api/status、POST /api/connection | 查询或保存当前账号的用户映射与初始化租约 | 检查 MemoryOS，按需创建独立用户 |
| POST /api/sessions | 创建当前账号作用域内会话 | 需要有效记忆连接 |
| GET /api/sessions | 分页查询当前账号、页面、模式下会话 | 需要有效记忆连接 |
| GET /api/sessions/{id}/messages | 分页读取消息、批量读取候选状态 | 需要有效记忆连接 |
| POST /api/sessions/{id}/chat | 请求去重、读取历史、保存用户与助手消息、训练候选 | 调用真实记忆召回和大模型 |
| 候选编辑、拒绝与确认接口 | 保存候选状态及确认幂等结果 | 仅确认操作向 MemoryOS 写入长期记忆 |

分页结果保留 `items`、`total`、`page`、`total_pages`。训练消息先生成候选，只有确认并取得真实记忆编号后才标记为已记住。数据库事务不跨越模型或 MemoryOS 网络调用；同步驱动访问通过工作线程执行，连接在短事务结束时释放。

用户选择新库意味着首次启动没有旧账号和历史，需重新注册；不自动认领旧 MemoryOS 用户。备份、恢复、授权和 systemd 配置见项目 [部署指南](../../../DEPLOY.md)。
