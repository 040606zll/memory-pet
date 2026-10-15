# LangChain 对话 API 说明

## 调用链路

`POST /api/sessions/{session_id}/chat` 的请求和响应结构保持不变。系统校验当前账号和会话，短事务读取历史，再调用 MemoryOS `/recall`，随后由 `Providers.reply()` 调用 `run_model_agent()`。

Agent 使用 `ChatOpenAI`、`create_agent(model=model, tools=[])` 和 `ainvoke()` 执行，输入包含模式规则、召回数据、本会话历史及最新消息；模型计算期间不持有数据库事务。Agent 不设置持久化 checkpointer，不跨账号共享对话状态。

- `training`：返回回复及最多五条待确认候选，不自动写入。
- `chat`：结合召回结果回复，候选强制为空。
- 普通记忆页面不返回宠物动作；宠物页面保持已有动作白名单。
- `POST /api/sessions/{session_id}/memories/confirm` 继续在用户确认后调用 MemoryOS `/ingest`。

## 配置与兼容

继续读取服务端 `[llm]` 的 `base_url`、`api_key`、`model`，不新增网页配置。支持模型根地址、`/v1` 地址和完整 `/chat/completions` 地址；最终由 LangChain 底层 SDK 发出 Chat Completions HTTP 请求。

显式使用 JSON 对象模式，保持 `max_tokens=1800`、温度 0.2；DeepSeek 保留关闭思考参数。HTTP 客户端由应用生命周期管理并注入 Agent，Agent 不关闭共享客户端。SDK 自动重试关闭，失败按已有幂等请求流程重试。

错误：超时 504；网络、鉴权、上游失败或无效/截断 JSON 回复 502。返回中文说明，不回显上游异常、Key 或内部配置。客户端取消继续传播到模型传输。

## 部署

同步 `backend/pet/model_agent.py`、`providers.py` 和 `requirements.txt`。本次同时修复 MySQL 库名误拦截，还需同步 `database.py`。保留服务器自己的 TOML 连接信息和 `start.sh` Conda 配置。

在服务器项目根目录安装当前 `memory` 环境依赖，然后重启受管后端：

```bash
/root/miniconda3/bin/conda run -n memory python -m pip install -r backend/requirements.txt
bash backend/start.sh restart
```

安装命令会更新该环境的项目依赖，重启命令会短暂中断本项目后端。此处仅提供部署步骤，本次没有在服务器执行。

官方接口：[create_agent](https://reference.langchain.com/python/langchain/agents/factory/create_agent)、[ChatOpenAI](https://reference.langchain.com/python/langchain-openai/chat_models/base/ChatOpenAI)。
