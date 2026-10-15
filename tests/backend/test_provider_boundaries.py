"""HTTP 适配器的错误、分页与写入契约，使用真实 httpx 传输边界。"""
import asyncio
import json
from dataclasses import replace

import httpx
import pytest

from pet.config import Connection
from pet.errors import ServiceError
from pet.providers import Providers

CONFIG = Connection('https://memory.test', 'private-marker', 'user', 'https://model.test/v1', 'private-model', 'model')


def run(handler, operation):
    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await operation(Providers(client))
    return asyncio.run(execute())


@pytest.mark.parametrize('failure,status', [('connection',502), ('invalid_json',502), ('quota_invalid_json',502), ('quota_list',502), ('quota_other',502)])
def test_http_failure_shapes_are_safe_and_never_leak_remote_details(failure, status):
    def handle(request):
        if failure == 'connection': raise httpx.ConnectError('private-marker', request=request)
        if failure in {'invalid_json','quota_invalid_json'}: return httpx.Response(403 if failure.startswith('quota') else 200, text='private-marker')
        return httpx.Response(403, json=[] if failure == 'quota_list' else {'detail': 'private-marker'})
    async def operation(providers):
        with pytest.raises(ServiceError) as error: await providers.memory(CONFIG, 'POST', '/users')
        assert error.value.status == status and 'private-marker' not in str(error.value)
    run(handle, operation)


def test_check_verifies_readiness_and_the_actual_user_read_permission():
    paths=[]
    def handle(request):
        paths.append(request.url.path)
        if request.url.path == '/health/ready': return httpx.Response(200,json={'status':'ready'})
        assert request.url.params['user_id'] == CONFIG.user_id
        return httpx.Response(200,json=[])
    run(handle, lambda providers: providers.check(CONFIG))
    assert paths == ['/health/ready','/memories']


@pytest.mark.parametrize('ready', [None, [], {}, {'status':'starting'}])
def test_readiness_rejects_nonready_remote_contract(ready):
    async def operation(providers):
        with pytest.raises(ServiceError) as error: await providers.check_ready(CONFIG)
        assert error.value.status == 503
    run(lambda request: httpx.Response(200,content=json.dumps(ready)), operation)


def test_unbounded_remote_memory_pages_fail_explicitly_without_faking_a_total():
    pages=[]
    def handle(request):
        pages.append(int(request.url.params['page']))
        return httpx.Response(200,json=[{'id':str(n),'content':'无个人信息的分页测试'} for n in range(200)])
    async def operation(providers):
        with pytest.raises(ServiceError) as error: await providers.memories(CONFIG,1,20,'筛选')
        assert error.value.status == 422
    run(handle, operation)
    assert pages == list(range(1,501))


@pytest.mark.parametrize('payload', [None, [], 'invalid', {'memory_ids': 'uuid'}, {'memory_ids': [None]}, {'memory_ids':['']}, {'memory_ids':42}, {'memory_ids': ['valid'], 'strengthened': 'invalid'}])
def test_malformed_ingest_success_never_becomes_a_successful_memory_confirmation(payload):
    async def operation(providers):
        with pytest.raises(ServiceError) as error: await providers.ingest(CONFIG, {'content':'用户喜欢雨声','source_id':'test:only'})
        assert error.value.status == 502
    run(lambda request: httpx.Response(200,json=payload), operation)


def test_ingest_can_return_strengthened_memories_without_duplicate_ids():
    payload={'memory_ids':['first'],'strengthened':[{},None,{'memory_id':'first'},{'id':'second'}]}
    assert run(lambda request:httpx.Response(200,json=payload), lambda providers:providers.ingest(CONFIG,{'content':'用户喜欢雨声','source_id':'test:only'})) == ['first','second']


@pytest.mark.parametrize('evidence', [None, [], ['invalid'], {}, {'source':'not-a-list'}])
def test_normalization_tolerates_missing_or_malformed_evidence_without_inventing_source(evidence):
    result=Providers.normalize({'id':'test','content':'事实','evidence':evidence})
    assert result['source'] == 'MemoryOS' and result['content'] == '事实'


def test_nonrecord_memory_list_entries_are_rejected_at_the_provider_boundary():
    async def operation(providers):
        with pytest.raises(ServiceError) as error: await providers.memories(CONFIG,1,20,'')
        assert error.value.status == 502
    run(lambda request:httpx.Response(200,json=[None]),operation)
