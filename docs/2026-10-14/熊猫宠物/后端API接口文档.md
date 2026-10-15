# 熊猫宠物后端 API

服务监听 `127.0.0.1:8797`，前端使用同源 `/api` 代理。代码全部在独立 `/Volumes/ORICO/project/memory-pet`，未修改 MemoryOS。

请求、返回字段详见 `workspace/2026-10-14/熊猫宠物/接口契约.md`。统一响应 `code/message/data`；错误不透传日志和秘密。MemoryOS 原仓库不存在指引提到的 `backend/app/common/response.py`，因此新项目实现同语义包装。

| 方法和路径 | 功能 |
| --- | --- |
| GET /api/status | 显示配置完整性与真实验证状态，只返回地址、用户、模型以及布尔状态 |
| POST /api/connection | 表单设置地址、Key、用户、模型；验证 MemoryOS readiness、用户归属和一次真实模型请求 |
| POST /api/disconnect | 清除进程内两个 Key，与当前验证状态 |
| POST /api/sessions | 创建训练或正式聊天会话 |
| GET /api/sessions | 按模式分页查询当前用户历史 |
| PATCH /api/sessions/{id} | 同一对话框切换训练和正式聊天 |
| GET /api/sessions/{id}/messages | 分页读取消息和最新候选状态 |
| POST /api/sessions/{id}/chat | 真实召回、结构化模型回复、动作及训练候选 |
| PATCH /api/sessions/{id}/candidates/{candidate_id} | 编辑或拒绝尚未确认的训练候选 |
| POST /api/sessions/{id}/memories/confirm | 用稳定 source_id 写入 MemoryOS 并幂等确认 |
| GET /api/sessions/{id}/memories | 搜索、分页查询真实 MemoryOS 长期记忆清单 |
| GET /api/health | 本地进程健康状态 |

训练模式只提出待确认的事实或偏好，不自动写入长期记忆。编辑候选后确认才通过 MemoryOS `/ingest` 抽取、去重、索引和存储。正式模式每次通过 `/recall` 读取真实记忆，再将内容与来源作为数据注入模型，不会虚构跨会话记忆。确认发生冲突、需要澄清或没有产生有效记忆时，返回中文错误且不假装已确认。写入结果不确定时冻结该候选的编辑和拒绝，先按原内容重试确认，防止远端已写但本地错误标为拒绝；明确未生成任何记忆时可编辑为新的修订版本，新修订使用内容哈希source_id。

会话作用域为服务 URL 与上游全局唯一用户 UUID。每次连接 Key 变化后先真实验证用户归属，失败无法读取旧历史；合法 Key 轮换保留同一用户历史。浏览器不能取得服务端秘密，秘密不写本地数据库。修改URL的origin（协议、host、端口）必须显式填写新Key，不能将旧Key发送到新服务；同origin修改path可留空继承。Key上限4096，非法输入不回显。

动作由用户命令优先决定，支持 `blink/wave/nod/shake_head/stretch/happy/sleep`，否定命令禁用相关动作。无命令时按模型情绪选择动作；悲伤情绪使用温柔点头，因为当前资产无独立悲伤动画。闲置自主动作由前端动画状态机调度，不调用网络。

SQLite 不持有模型期间事务：准备上下文短连接→释放连接→MemoryOS/模型→保存消息短事务。客户端断开会取消 HTTP 调用和模型任务，幂等状态恢复可重试。聊天幂等键在每会话内唯一，外部 recall request_id 由会话和幂等键派生 UUID，避免跨会话误重放。宠物会话 ID 仅用于本地上下文，不能传给 MemoryOS session_id（其必须绑定真实 MemoryOS chat_sessions）；长期召回不传此字段。

原 MemoryOS `/memories` 是分页数组、没有总数。适配层读取远端所有分页后返回真实总数；超过十万项要求缩小搜索范围。没有把本地记录作为长期记忆兜底。

运行：进入 backend，使用现有 `/opt/anaconda3/envs/xyd/bin/python run.py`。环境参数 `MEMORYOS_BASE_URL/MEMORYOS_API_KEY/MEMORYOS_USER_ID/LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` 仅从进程读取；亦可使用浏览器连接表单。DeepSeek 显式关闭 thinking；兼容接口只发起一次请求，无隐式自动重试。模型正文必须为非空真实字符串；未知情绪归为neutral，可选动作严格筛白名单、候选只保留有效字符串，不会因为非关键字段无效丢弃有效正文，也不会补造正文。

SQLite 完整 SQL 在 `backend/sql/sqlite/001_local_sessions.sql`。首次运行自动初始化；可选 Alembic revision 在 `backend/app/alembic/versions/20261014_001_local_sessions.py`，仅能用于本项目 SQLite，不能执行到 MemoryOS 的数据库上。
