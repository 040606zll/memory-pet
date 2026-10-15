# 后端配置文件说明

日期：2026-10-15。HTTP 接口没有新增或改动，模型配置仍不接受网页提交。

## 文件与优先级

后端启动自动读取 `backend/config.toml` 与可选的 `backend/config.local.toml`，无需手工加载。优先级：进程环境变量 > 本机文件 > 默认文件。只覆盖指定字段，未指定字段沿用低优先级值；空环境值也会覆盖文件。修改后重启后端，无需构建前端。

| 文件字段 | 对应环境变量 | 用途 |
| --- | --- | --- |
| `llm.base_url` | `LLM_BASE_URL` | 兼容 Chat Completions 的模型地址 |
| `llm.api_key` | `LLM_API_KEY` | 模型密钥 |
| `llm.model` | `LLM_MODEL` | 模型名称 |
| `memoryos.base_url` | `MEMORYOS_BASE_URL` | 上游 MemoryOS 地址 |
| `memoryos.api_key` | `MEMORYOS_API_KEY` | 上游业务密钥 |
| `memoryos.user_id` | `MEMORYOS_USER_ID` | 上游用户 UUID |
| `storage.database` | `PET_DATABASE` | 宠物本地 SQLite 文件 |

TOML 文件中的数据库相对路径以该配置文件目录为基准；环境变量数据库路径保持原有语义。两个配置文件均不存在时仍支持纯环境变量部署。配置文件存在但读取失败、TOML 无效、字段未知或值不是字符串时，阻止启动并报中文错误，不回显配置值。

默认文件不包含真实凭据。本机覆盖文件已加入 Git 忽略规则，须保护权限，不得进入公开发布包；可由管理员复制默认文件再填写，具体步骤见根目录 `DEPLOY.md` 第 3 节。页面状态仍仅公开模型是否已配置，不返回模型三项。
