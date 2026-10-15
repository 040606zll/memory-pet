# 普通记忆对话后端 API

独立项目 `/Volumes/ORICO/project/memory-pet`，本轮只修改后端、后端测试与文档，未修改前端、MemoryOS 核心、凭据或环境文件，也未重启服务。

## 会话契约

统一响应仍为 `{code:0,message:"成功",data:...}`；失败为中文语义消息，没有上游堆栈、凭据或假回复。原有会话、消息、训练候选、分页和确认路由保持兼容。

| 接口 | 本轮变化 |
| --- | --- |
| POST /api/sessions | 增加可选 `surface:"pet"或"memory"`，默认pet；mode仍为training或chat；返回增加surface |
| GET /api/sessions | 增加surface过滤，默认pet；普通页面显式传surface=memory；page、limit、mode不变 |
| PATCH /api/sessions/{id} | 仅允许mode，不能修改surface；返回会话包含surface |
| POST /api/sessions/{id}/chat | 请求结构不变，依据已存surface选择普通助手或宠物人格；普通会话actions始终为空 |
| POST /api/sessions/{id}/memories/confirm | 普通会话向真实MemoryOS写入source="记忆对话测试"；宠物仍为"熊猫宠物训练" |

创建普通训练会话：`{"surface":"memory","mode":"training","title":"记忆写入测试"}`。普通页面未填title时默认为“记忆对话”。创建旧宠物会话无需传surface，原默认标题与行为不变。

会话对象：`{id,mode,title,created_at,surface}`。清单仍为 `{items,total,page,total_pages}`。普通历史查询示例：`GET /api/sessions?surface=memory&mode=chat&page=1&limit=20`。

消息仍为 `{id,role,content,emotion,actions,memories,candidates,created_at}`。训练候选仍为 `{id,content,status,memory_ids}`，支持修正、拒绝、确认、失败后安全重试。

## 真实记忆边界

每次聊天先真实调用MemoryOS `/recall`，再将其结果作为数据注入真实大模型。SQLite的消息仅是本会话上下文，不作为长期记忆来源。未确认候选不能声称已经写入。只有确认请求经真实 `/ingest` 返回有效远端 memory_ids 后才标记confirmed；冲突、零有效记忆、超时和服务失败保持原有中文错误及重试语义。

同一MemoryOS用户的长期记忆在两种页面之间共享，历史会话按surface分开展示。新普通会话可以召回宠物确认的长期记忆，来源标签原样展示；没有复制宠物本地历史来伪装长期召回。

普通surface使用普通中文助手提示词，不带宠物名字或熊猫人格，不描述动物动作。模型输出动作在Providers层清空，Service也不运行宠物命令解析；即使模型错误返回wave或用户说“眨眼”，普通消息actions仍为[]。

## 幂等与兼容

新聊天幂等指纹包含surface、mode、pet_name和原始用户content，避免跨页面结果重放。旧宠物指纹只在pet作用域下兼容读取，原有request_id重放不会突然409；普通会话不能使用这一旧格式兼容路径。

训练候选固定source_id与现有重试规则不变，不因增加surface修改旧候选source_id。普通会话只切换对外source标签。模式切换不能改surface。

准备历史、模型计算与保存阶段继续分离为短事务；没有新增依赖、模型兜底、自动模型重试或循环逐候选数据库查询。

## 数据库升级

- 新库完整SQLite建表：`backend/sql/sqlite/001_local_sessions.sql`，sessions增加surface默认pet和取值检查。
- SQLite旧库升级：`backend/sql/sqlite/002_session_surface.sql`。Store启动时在BEGIN IMMEDIATE写锁内检查PRAGMA，只有列不存在才执行ALTER；重复启动不会重复加列，旧会话默认pet，消息、候选内容与source_id保持不变。
- 可选Alembic revision：`backend/app/alembic/versions/20261014_002_session_surface.py`，继承20261014_001，检查列是否已有，升级幂等。
- MySQL 8参考SQL：`backend/sql/mysql/002_session_surface.sql`；PostgreSQL参考SQL：`backend/sql/postgresql/002_session_surface.sql`。当前运行时仍只支持SQLite；没有引入这些数据库驱动，也未宣称已在真实MySQL/PostgreSQL执行。

所有INSERT已显式列名，避免旧库升级或列顺序变化导致数据错位。生产库升级将在master重启新版服务时执行；后端测试通过conftest隔离默认PET_DATABASE，未迁移当前正在运行的产品数据库。手工执行ALTER前应检查列不存在，已经自动升级后不要再次执行裸SQL。降级会丢失页面归属，迁移脚本拒绝自动删除列。

## 修改文件

schemas.py增加surface；store.py增加兼容迁移、筛选、明确列和旧指纹兼容；service.py选择人格、空动作与source标签；providers.py增加普通助手提示词；main.py传递参数和普通默认标题；SQLite建表及三种数据库升级SQL、Alembic新增迁移；tests/backend新增隔离conftest与普通链路测试，HTTP替身按真实ingest source返回来源。
