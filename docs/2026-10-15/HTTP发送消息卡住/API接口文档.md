# 消息发送链路与 HTTP 兼容修复

本次没有新增或修改后端接口、认证、数据库及部署配置。

| 操作 | 浏览器请求（公开前缀 /pet-api） | 后端调用 |
| --- | --- | --- |
| 首次发送 | `POST /sessions`，`mode=training` 或 `chat` | 解析当前账号映射、验证实际用户及记忆权限，创建本地会话 |
| 训练/正式对话发送 | `POST /sessions/{id}/chat`，参数 `content,pet_name,request_id` | MemoryOS `POST /recall`，再调用模型 `POST /chat/completions`，返回回复和候选 |
| 确认训练记忆 | `POST /sessions/{id}/memories/confirm`，参数 `candidate_id` | MemoryOS `POST /ingest`，取得真实记忆 ID 后标记已确认 |

普通记忆页使用同一接口，创建会话时增加 `surface=memory`。当前训练实现是提取候选并在确认后写入；发送时并不直接调用 MemoryOS 专用训练会话接口。

原错误发生在首次 HTTP 请求之前：前端设为 busy，再执行 `crypto.randomUUID()`，公网 HTTP 页面未提供该方法，抛出异常；该行位于 try 外，finally 无法释放等待状态。修复使用共享 `newRequestId()`：原生能力存在时沿用，否则用 `getRandomValues` 生成 UUID v4。准备流程全部纳入 try/finally；不支持随机字节时展示中文错误，保留草稿并解锁界面。

消息重试继续复用同一个 request_id；不会因重试生成新编号。本次未更改消息、记忆或响应结构。
