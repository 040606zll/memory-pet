"""实际执行 LangChain Agent，仅替换模型 HTTP 传输，不调用外网或数据库。"""
import asyncio
from dataclasses import replace
import json
from unittest.mock import Mock

import httpx
import pytest

from pet.config import Connection
from pet.errors import ServiceError
from pet.providers import Providers
from pet.schemas import ChatBody
from pet.service import PetService


CONFIG = Connection('http://memory.test', 'memory-key', 'user-id', 'https://model.test/v1', 'private-key', 'test-model')
BODY = {'reply': '你好，等你确认后保存。', 'emotion': 'happy', 'actions': ['wave'], 'candidates': ['用户喜欢绿茶']}


def completion(content=None, finish='stop'):
    return {'choices': [{'message': {'role': 'assistant', 'content': json.dumps(BODY, ensure_ascii=False) if content is None else content}, 'finish_reason': finish}]}


@pytest.mark.parametrize('mode,surface', [('training', 'pet'), ('chat', 'pet'), ('training', 'memory'), ('chat', 'memory')])
def test_real_agent_receives_history_memories_and_keeps_output_contract(monkeypatch, mode, surface):
    from pet import model_agent
    create = Mock(wraps=model_agent.create_agent)
    monkeypatch.setattr(model_agent, 'create_agent', create)
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=completion())

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle), trust_env=False) as client:
            output = await Providers(client).reply(CONFIG, mode, '我喜欢绿茶', [{'role': 'user', 'content': '上一条消息'}], [{'content': '用户喜欢散步'}], '小旺', surface)
            assert output.reply == BODY['reply']
            assert output.candidates == (BODY['candidates'] if mode == 'training' else [])
            assert output.actions == (BODY['actions'] if surface == 'pet' else [])
            assert not client.is_closed

    asyncio.run(scenario())
    create.assert_called_once()
    assert create.call_args.kwargs['tools'] == []
    assert len(calls) == 1 and str(calls[0].url) == 'https://model.test/v1/chat/completions'
    assert calls[0].headers['authorization'] == 'Bearer private-key'
    payload = json.loads(calls[0].content)
    assert payload['model'] == 'test-model' and payload['response_format'] == {'type': 'json_object'}
    assert payload['max_tokens'] == 1800 and 'max_completion_tokens' not in payload
    assert 'tools' not in payload and 'thinking' not in payload
    assert '用户喜欢散步' in payload['messages'][1]['content']
    assert payload['messages'][2]['content'] == '上一条消息'
    assert payload['messages'][-1]['content'].endswith('我喜欢绿茶')


@pytest.mark.parametrize('base,expected', [('https://model.test', 'https://model.test/chat/completions'), ('https://model.test/v1', 'https://model.test/v1/chat/completions'), ('https://model.test/v1/chat/completions', 'https://model.test/v1/chat/completions'), ('https://api.deepseek.com', 'https://api.deepseek.com/chat/completions')])
def test_agent_supports_configured_endpoints_and_deepseek_parameters(base, expected):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=completion())

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            await Providers(client).reply(replace(CONFIG, llm_url=base), 'chat', '你好', [], [])

    asyncio.run(scenario())
    assert str(calls[0].url) == expected
    assert json.loads(calls[0].content).get('thinking') == ({'type': 'disabled'} if 'api.deepseek.com' in base else None)


@pytest.mark.parametrize('status,kind', [(401, '鉴权失败'), (403, '鉴权失败'), (429, '状态码 429'), (503, '状态码 503')])
def test_agent_errors_are_chinese_private_and_not_automatically_retried(status, kind):
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={'error': {'message': 'private-key upstream-stack'}})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with pytest.raises(ServiceError) as error:
                await Providers(client).reply(CONFIG, 'training', '你好', [], [])
            assert error.value.status == 502 and kind in error.value.message
            assert 'private-key' not in str(error.value) and 'upstream-stack' not in str(error.value)

    asyncio.run(scenario())
    assert len(calls) == 1


@pytest.mark.parametrize('kind,status', [('timeout', 504), ('connection', 502)])
def test_agent_transport_failure_is_retryable_without_leaking_errors(kind, status):
    def handle(request):
        error = httpx.ReadTimeout if kind == 'timeout' else httpx.ConnectError
        raise error('private-key', request=request)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with pytest.raises(ServiceError) as error:
                await Providers(client).reply(CONFIG, 'chat', '你好', [], [])
            assert error.value.status == status and 'private-key' not in str(error.value)

    asyncio.run(scenario())


@pytest.mark.parametrize('body', [completion('非JSON'), completion('   '), completion('{}'), completion('[]'), completion([{'type': 'text', 'text': '不符合正文契约'}]), completion(finish='length'), completion(finish='content_filter'), {'choices': []}, {'choices': [{'message': {}}]}, {'choices': [{'message': {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'call-1', 'type': 'function', 'function': {'name': 'write_memory', 'arguments': '{}'}}]}, 'finish_reason': 'tool_calls'}]}])
def test_agent_rejects_invalid_or_truncated_reply(body):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
            with pytest.raises(ServiceError, match='有效的回复结构') as error:
                await Providers(client).reply(CONFIG, 'training', '你好', [], [])
            assert error.value.status == 502

    asyncio.run(scenario())


def test_agent_accepts_legacy_json_fence_without_faking_reply():
    async def scenario():
        body = completion('```json\n' + json.dumps(BODY) + '\n```')
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
            output = await Providers(client).reply(CONFIG, 'training', '你好', [], [])
            assert output.reply == BODY['reply']

    asyncio.run(scenario())


def test_agent_cancellation_propagates_to_transport():
    async def scenario():
        entered, cancelled = asyncio.Event(), asyncio.Event()

        async def handle(request):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            task = asyncio.create_task(Providers(client).reply(CONFIG, 'chat', '你好', [], []))
            await asyncio.wait_for(entered.wait(), 3)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert cancelled.is_set() and not client.is_closed

    asyncio.run(scenario())


def test_training_confirmation_and_formal_chat_use_agent_and_existing_memory_boundary():
    calls, stored = [], []
    store = Mock()
    store.session.return_value = {'surface': 'pet', 'mode': 'training'}
    store.history.return_value = []
    store.begin_operation.return_value = None

    def handle(request):
        calls.append(request.url.path)
        if request.url.path == '/recall':
            return httpx.Response(200, json={'facts': stored})
        if request.url.path == '/ingest':
            stored.append({'id': 'memory-id', 'content': '用户喜欢绿茶'})
            return httpx.Response(200, json={'memory_ids': ['memory-id']})
        return httpx.Response(200, json=completion())

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            service = PetService(store, Providers(client))
            trained = await service.chat(CONFIG, 'session', ChatBody(content='我喜欢绿茶', request_id='training-id'))
            candidate = trained['assistant_message']['candidates'][0]
            assert candidate['status'] == 'pending' and '/ingest' not in calls
            store.candidate.return_value = {**candidate, 'source_id': 'source-id'}
            confirmed = await service.confirm(CONFIG, 'session', candidate['id'])
            assert confirmed['status'] == 'confirmed' and len(stored) == 1
            store.session.return_value = {'surface': 'pet', 'mode': 'chat'}
            answer = await service.chat(CONFIG, 'session', ChatBody(content='我喜欢什么？', request_id='chat-id'))
            assert answer['assistant_message']['candidates'] == []
            assert answer['assistant_message']['memories'][0]['content'] == '用户喜欢绿茶'

    asyncio.run(scenario())
    assert calls == ['/recall', '/v1/chat/completions', '/ingest', '/recall', '/v1/chat/completions']
    assert store.complete_chat.call_count == 2
    store.complete_confirmation.assert_called_once()


def test_failed_agent_call_restores_operation_without_saving_messages():
    store = Mock()
    store.session.return_value = {'surface': 'pet', 'mode': 'training'}
    store.history.return_value = []
    store.begin_operation.return_value = None

    def handle(request):
        return httpx.Response(200, json={'facts': []}) if request.url.path == '/recall' else httpx.Response(503, json={'error': {'message': 'private-key'}})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with pytest.raises(ServiceError):
                await PetService(store, Providers(client)).chat(CONFIG, 'session', ChatBody(content='你好', request_id='retry-id'))

    asyncio.run(scenario())
    store.fail_operation.assert_called_once_with('session:retry-id')
    store.complete_chat.assert_not_called()
