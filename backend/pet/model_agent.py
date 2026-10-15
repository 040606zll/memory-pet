"""通过 LangChain Agent 异步调用对话模型，复用应用管理的 HTTP 连接池。"""
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.utils.json import parse_partial_json
from langchain_openai import ChatOpenAI
from openai import APIConnectionError, APIResponseValidationError, APIStatusError, APITimeoutError, ContentFilterFinishReasonError, LengthFinishReasonError

from .errors import ServiceError


async def run_model_agent(client, connection, messages, on_delta=None):
    # 配置兼容根地址、/v1 地址和旧的完整 Chat Completions 地址。
    base_url = connection.llm_url.removesuffix('/chat/completions')
    # 兼容模型使用 max_tokens；放入 extra_body 避免 SDK 自动改成 max_completion_tokens。
    extra_body = {'max_tokens': 1800}
    if 'api.deepseek.com' in base_url:
        extra_body['thinking'] = {'type': 'disabled'}
    try:
        model = ChatOpenAI(
            model=connection.model, api_key=connection.llm_key, base_url=base_url,
            http_async_client=client, http_socket_options=(), timeout=client.timeout,
            use_responses_api=False, max_retries=0, temperature=0.2, cache=False,
            model_kwargs={'response_format': {'type': 'json_object'}}, extra_body=extra_body,
        )
        # 长期记忆由现有召回、人工确认链路管理，不向 Agent 开放自动写入工具。
        # 官方接口：https://reference.langchain.com/python/langchain/agents/factory/create_agent
        agent = create_agent(model=model, tools=[])
        if on_delta is None:
            result = await agent.ainvoke({'messages': messages}, config={'recursion_limit': 4})
            message = result['messages'][-1]
        else:
            message, raw, emitted = None, '', ''
            async for chunk, _ in agent.astream({'messages': messages}, config={'recursion_limit': 4}, stream_mode='messages'):
                if not isinstance(chunk, AIMessageChunk) or not isinstance(chunk.content, str):
                    raise ValueError('模型流结构无效')
                message = chunk if message is None else message + chunk
                raw += chunk.content
                if len(raw) > 32000:
                    raise ValueError('模型输出过长')
                try:
                    partial = parse_partial_json(raw)
                except ValueError:
                    continue
                text = partial.get('reply', '') if isinstance(partial, dict) else ''
                if isinstance(text, str) and text and 0xD800 <= ord(text[-1]) <= 0xDBFF:
                    text = text[:-1]
                if isinstance(text, str) and text.startswith(emitted) and len(text) > len(emitted):
                    if len(text) > 8000:
                        raise ValueError('回复过长')
                    await on_delta(text[len(emitted):])
                    emitted = text
        if (not isinstance(message, AIMessage) or message.tool_calls
                or message.response_metadata.get('finish_reason') in {'length', 'content_filter'}
                or not isinstance(message.content, str)):
            raise ValueError('模型回复结构无效或输出被截断')
        return message.content
    except APITimeoutError:
        raise ServiceError('大模型响应超时，请稍后重试', 504) from None
    except APIConnectionError:
        raise ServiceError('无法连接大模型，请检查服务地址', 502) from None
    except APIStatusError as error:
        if error.status_code in {401, 403}:
            raise ServiceError('大模型鉴权失败，请检查 API Key 和用户权限', 502) from None
        raise ServiceError(f'大模型请求失败（状态码 {error.status_code}），请检查服务状态', 502) from None
    except (APIResponseValidationError, ContentFilterFinishReasonError, LengthFinishReasonError):
        raise ServiceError('大模型未返回有效的回复结构，请重试或检查模型兼容性', 502) from None
