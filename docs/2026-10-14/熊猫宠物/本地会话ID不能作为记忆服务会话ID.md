# 本地会话 ID 不能直接用于 MemoryOS 会话

问题：独立宠物项目创建的 UUID 会话传入 MemoryOS `/recall` 的 `session_id` 后，真实接口返回 422。

复现：创建宠物本地 session，将其 UUID 作为 `/recall.session_id`；该 ID 不在 MemoryOS `chat_sessions`，无法通过真实会话归属校验。仅验证 Pydantic UUID 形状的 HTTP 替身不能发现此问题。

根因：两个服务各自拥有会话命名空间，UUID 形状相同不表示业务实体可通用。MemoryOS session_id 用于它自身的短期会话历史作用域，宠物 UUID 只标识本地聊天上下文。

修复：长期记忆召回不传 MemoryOS session_id；宠物在模型 prompt 中使用自身最近20条消息历史。对外 recall request_id 则从本地session与幂等键派生稳定UUID，只作为合法请求编号使用。

验证：test_full_training_confirmation_and_cross_session_recall 明确断言上游payload没有session_id；master通过真实MemoryOS+真实LLM再次验证完整训练及跨会话召回链路。这个替身断言验证的是边界契约，真实链路结果必须另行检查。

避免再现：跨服务传递 ID 之前检查实体归属、租户校验和创建来源；未建立实际映射时不能混用业务实体 ID。
