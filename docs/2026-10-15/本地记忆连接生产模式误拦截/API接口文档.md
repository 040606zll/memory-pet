# 取消连接模式校验

日期：2026-10-15。用户要求取消项目中的生产鉴权模式判断。

接口及参数保持不变：登录后 `GET /api/status` 检查连接，`POST /api/connection` 携带 Cookie、CSRF 和空 JSON `{}` 重试。

连接仍要求上游 `/health/ready` 的 `status=ready`，但不读取或判断 `profile`，不再返回“记忆服务尚未启用生产鉴权模式，请联系管理员配置”。用户创建、绑定、状态、Key 归属和实际记忆权限检查保留。

`status` 在连接失败时以 `connected=false` 和中文 `memory_error` 展示错误；重试接口使用统一 `{code,message,data}` 错误响应。上游拒绝凭据时仍返回 503，提示“记忆服务的服务端凭据无效或权限不足，请联系管理员处理”。

本次不修改数据库、真实凭据、环境文件、启动脚本或 MemoryOS；没有新增接口或迁移。对外部署 MemoryOS 的 production 要求仍由部署流程落实。
