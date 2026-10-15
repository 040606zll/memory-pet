# 大模型后端配置：接口说明

日期：2026-10-15。适用于宠物页 `/` 与普通对话页 `/memory`，均使用宠物后端 8797 的接口。

## 配置来源

宠物后端启动时读取 `backend/config.toml` 与可选的 `backend/config.local.toml`。后者覆盖前者，进程环境变量具有最高优先级。值由服务器管理员提供，不写入网页或浏览器存储。

| 环境变量 | 含义 |
| --- | --- |
| `LLM_BASE_URL` | 兼容 Chat Completions 的模型基础地址，按供应商要求包含 `/v1`；也支持完整 `/chat/completions` 地址 |
| `LLM_API_KEY` | 模型服务密钥 |
| `LLM_MODEL` | 模型名称 |

对应文件字段为 `[llm]` 下的 `base_url`、`api_key`、`model`，完整示例见项目根目录 `DEPLOY.md`。文件方式与原环境变量方式均可使用。

修改后重启宠物后端；Linux EnvironmentFile 示例见项目根目录 `DEPLOY.md` 第 3 节。无需改动 MemoryOS 的配置。

## POST /api/connection

页面只提交记忆服务连接：

```json
{
  "memoryos": {
    "base_url": "http://127.0.0.1:8863",
    "api_key": "<记忆服务密钥>"
  }
}
```

`api_key` 可省略或留空以保留同源地址下已有的 MemoryOS Key；改变协议、主机或有效端口时必须重新填写。模型地址、密钥、名称均使用服务端配置。只有真实 MemoryOS 权限检查与模型问候均成功才替换当前记忆连接，可能产生一次模型调用费用。

用户 ID 改为由后端自动绑定，详见 `../Key用户自动绑定/API接口文档.md`。旧接口可选传入 UUID 以兼容固定用户，但必须通过远端归属验证且不得覆盖已有绑定。无可复用用户时会在 MemoryOS 创建专属用户并占用一个名额；无鉴权目录拒绝自动绑定。

| 情况 | HTTP 状态与行为 |
| --- | --- |
| 完成双重验证 | 200，`data.connected=true` |
| 最终配置缺少模型地址、密钥或名称 | 428，中文提示联系管理员在宠物后端配置后重启；不请求上游 |
| 客户端提交 `llm`、`llm_url`、`llm_key`、`model` 等额外字段 | 422，不替换配置、不调用上游、不回显提交值 |
| MemoryOS 用户 ID 或地址无效 | 400，返回中文提示 |
| 更换 MemoryOS 来源但未提供新 Key | 422，要求重新填写 |
| 上游验证失败 | 返回既有中文错误响应，原连接保持不变 |

兼容性变化：旧版携带 `llm` 的请求会返回 422，前后端必须一起更新。

## GET /api/status

响应沿用 `{code,message,data}`。`data.llm` 仅包含 `{"configured":true}` 或 `{"configured":false}`，不返回模型 URL、名称或 Key；`llm_validated` 表示本次进程是否通过模型验证，`memory_validated` 表示记忆服务验证状态。只有两项均通过，`connected` 才为 true。配置完整不代表已验证。

## POST /api/disconnect

清除进程内的 MemoryOS Key 并重置验证状态，完整保留服务端模型三项。返回断开后的状态。重连只需提供 MemoryOS Key，无需传递模型配置。
