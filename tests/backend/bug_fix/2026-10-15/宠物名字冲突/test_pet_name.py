"""宠物名字的模型协议、消息持久化及普通助手隔离回归；不调用真实数据库。"""
import asyncio
import json
from unittest.mock import Mock

import httpx
import pytest

from pet.config import Connection
from pet.providers import Providers
from pet.schemas import ChatBody, ModelOutput
from pet.service import PetService


CONFIG = Connection('http://memory.test', 'memory-key', 'account-user', 'https://model.test/v1', 'private-key', 'test-model')


@pytest.mark.parametrize('name,expected', [('羊狗', '羊狗'), ('  团团  ', '团团'), ('小忆', '小忆'), (None, None), ('', None), ('a' * 13, None), (42, None), ({'name': '羊狗'}, None), ('羊\n狗', None)])
def test_optional_pet_name_is_validated_without_discarding_real_reply(name, expected):
    output = ModelOutput.from_model({'reply': '你好，我会陪着你。', 'pet_name': name})
    assert output.reply == '你好，我会陪着你。'
    assert output.pet_name == expected


@pytest.mark.parametrize('mode,surface', [('training', 'pet'), ('chat', 'pet'), ('training', 'memory'), ('chat', 'memory')])
def test_name_survives_real_agent_and_chat_persistence_without_auto_confirm(mode, surface):
    store = Mock()
    store.session.return_value = {'surface': surface, 'mode': mode}
    store.history.return_value = []
    store.begin_operation.return_value = None
    calls = []

    def handle(request):
        calls.append(request)
        if request.url.path == '/recall':
            return httpx.Response(200, json={'facts': [{'id': 'memory-1', 'content': '用户给宠物狗起的称呼是“羊狗”'}]})
        output = {'reply': '好呀，你可以叫我羊狗。', 'pet_name': '羊狗', 'candidates': ['用户给宠物起的名字是羊狗']}
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': json.dumps(output, ensure_ascii=False)}, 'finish_reason': 'stop'}]})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await PetService(store, Providers(client)).chat(CONFIG, 'session-1', ChatBody(content='你叫羊狗', request_id='rename-1'))
        assistant = result['assistant_message']
        if surface == 'pet':
            assert assistant['pet_name'] == '羊狗'
        else:
            assert 'pet_name' not in assistant
        assert assistant['content'] == '好呀，你可以叫我羊狗。'
        assert len(assistant['candidates']) == (1 if mode == 'training' else 0)
        assert all(item['status'] == 'pending' for item in assistant['candidates'])
        assert store.complete_chat.call_args.args[2] == result

    asyncio.run(scenario())
    assert [request.url.path for request in calls] == ['/recall', '/v1/chat/completions']
    payload = json.loads(calls[-1].content)
    if surface == 'pet':
        assert '页面显示的兜底名字' in payload['messages'][0]['content']
        assert '用户设置的宠物名字' not in payload['messages'][0]['content']
        assert 'pet_name' in payload['messages'][-1]['content']
    else:
        assert '页面显示的兜底名字' not in payload['messages'][0]['content']


def test_legacy_reply_does_not_forge_a_resolved_name():
    output = ModelOutput.from_model({'reply': '你好'})
    assert output.pet_name is None


def test_idempotent_replay_preserves_resolved_name_without_second_model_call():
    store, providers = Mock(), Mock()
    store.session.return_value = {'surface': 'pet', 'mode': 'training'}
    stored = {'user_message': {'content': '你叫羊狗'}, 'assistant_message': {'content': '好呀，叫我羊狗吧。', 'pet_name': '羊狗', 'candidates': []}}
    store.begin_operation.return_value = stored
    store.candidates_by_ids.return_value = {}
    result = asyncio.run(PetService(store, providers).chat(CONFIG, 'session-1', ChatBody(content='你叫羊狗', request_id='rename-1')))
    assert result == stored and result['assistant_message']['pet_name'] == '羊狗'
    providers.reply.assert_not_called()
    providers.recall.assert_not_called()
    store.complete_chat.assert_not_called()
