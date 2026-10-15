# 账号密码登录 API 接口文档

日期：2026-10-15。项目：memory-pet。用户已确认统一账号登录、本地账号与 MemoryOS 用户映射、服务端统一管理 Key。实现不修改 MemoryOS 核心、实际服务凭据或环境文件。

## 地址与身份

浏览器使用 `frontend/src/config.js` 的 `/pet-api`，开发代理和 Nginx 将其转换为后端 `/api`。以下接口以 `/api` 表示真实后端路径。响应统一使用 `backend/app/common/response.py`：`{code,message,data}`，成功 code=0，错误 code=HTTP 状态码，message 为中文。账号及业务响应均 `Cache-Control: no-store`。

账号由 HttpOnly、SameSite=Strict Cookie `memory_pet_session` 标识，有效期七天；HTTPS 请求启用 Secure。所有已登录变更请求要求 `X-CSRF-Token`，不能从前端提交或覆盖 MemoryOS Key、地址及用户编号。CSRF 只存在页面内存中，登录令牌只保存 SHA-256 摘要，密码采用随机盐 scrypt 哈希。

| 方法 | 路径 | 请求与行为 |
| --- | --- | --- |
| POST | `/api/auth/register` | JSON `{username,password}`；注册并登录，返回 `{user:{id,username},csrf_token}` |
| POST | `/api/auth/login` | 同上；登录并轮换本浏览器旧会话令牌，返回同样结构 |
| GET | `/api/auth/me` | 返回当前 `{user,csrf_token}`；未登录或过期 401 |
| POST | `/api/auth/logout` | Cookie + CSRF；注销当前令牌并清除 Cookie，data=null |
| GET | `/api/status` | Cookie；按当前账号初始化/检查记忆连接，返回业务连接状态，不返回任何 Key |
| POST | `/api/connection` | Cookie + CSRF，JSON `{}`；重试本账号记忆连接，失败返回明确错误 |
| POST | `/api/disconnect` | 兼容路径固定返回 409，提示使用退出登录切换账号 |
| GET | `/api/health` | 无需登录，只表示宠物进程存活 |

用户名为 3–32 位英文字母、数字、下划线，保存前转小写；密码 8–128 位。重复账号返回 409；错误账号和错误密码使用相同的 401 提示。十五分钟内，同一账号最多五次失败登录，同一客户端登录/注册请求各最多三十次，触发后 429。客户端地址采用 ASGI 已校验的连接地址；反向代理部署须正确配置 Uvicorn 的可信代理。

注册、登录本身不访问上游，因此服务故障不阻断账号使用。首次业务页读取 status 才初始化远端用户，模型配置不齐全时先提示配置错误，不创建无用用户。当前 status 会触发初始化，应由当前登录页面发起，不用于外部监控轮询。

状态 data 包含 `memoryos:{configured,user_id}`、`llm:{configured}`、`actions`、`connected`、`memory_validated`、`llm_validated`、`memory_error`。失败时 connected=false，memory_error 是可展示中文提示；`llm_validated` 为兼容字段，只代表服务端模型配置完整，不代表已运行模型推理。实际模型验证发生在聊天请求。

## 账号与上游用户

一个服务 Key 可管理多个远端用户；`account_memory_bindings` 按本地账号和服务地址唯一映射到远端用户，不再按 Key 一对一选用户。远端用户使用 `MemoryPet:<本地账号UUID>` 稳定标记，创建响应丢失后按标记恢复，不无条件重复建号。多个同名结果或绑定用户被禁用、归属变化时停止连接，不更换用户。每个新远端用户占用一个上游用户额度。

MemoryOS 必须 ready，项目不校验 profile 名称，允许本地 simple 模式；对外部署仍须使用 production 模式。服务端 Key 必须有效并有相应目录和记忆权限。新用户目录查询携带 Key，读取精确账号标记；已绑定用户核对其状态、Key 归属及记忆权限。网络调用不持有 SQLite 事务；同账号进程锁与持久短租约防止并发初始化，远端 HTTP 完成后才写入映射。

旧 `MEMORYOS_USER_ID` 和 `memory_user_bindings` 不参与新账号映射，旧会话与旧记忆保留，不自动分配给新账号。新历史 scope 由本地账号 ID 和服务地址生成，更换服务地址需要单独设计数据迁移。

## 原有业务接口

`/api/sessions`、会话模式、消息、聊天、候选编辑/拒绝、记忆确认和清单接口保留原参数与分页，全部追加 Cookie 鉴权及变更 CSRF。每个请求由服务端确定本地账号及 MemoryOS 用户，忽略客户端伪造身份。访问其他账号的会话或候选返回 404，且不调用其召回、写入或模型流程。

## 数据库迁移与部署

新增 `local_accounts`、`login_sessions`、`account_memory_bindings`、`login_attempts` 四张表，使用逻辑关联。SQLite 启动幂等建表；生产迁移为 `backend/app/alembic/versions/20261015_004_accounts.py`，完整 SQL 分别位于 `backend/sql/{sqlite,postgresql,mysql}/004_accounts.sql`。其他数据库 SQL 已提供，但运行时仍仅支持 SQLite，未进行真实 PostgreSQL/MySQL 验收。

后端部署应保留整个 `backend/app` 公共响应及迁移目录；同时备份宠物数据库，其中包含密码哈希、有效登录会话和用户映射，须按敏感数据保护。公开注册没有邮箱验证、邀请制、找回密码或后台账号管理，正式开放注册前应按业务需求补充。

当前本机 MemoryOS 返回 profile=simple，项目已取消对其拦截。原配置 Key 访问用户目录仍返回 401；未改写任何真实凭据，真实记忆端到端成功验收仍受该凭据问题阻塞。
