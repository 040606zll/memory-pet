"""保留的旧连接适配器契约：真实 MySQL 绑定约束，HTTP 边界替身模拟远端。"""
import asyncio
from dataclasses import replace
import uuid

import httpx
import pytest

from pet.config import Connection
from pet.connections import Connections, USER_LABEL, AccountConnections
from pet.errors import ServiceError
from pet.providers import Providers
from test_api import Remote, USER, KEY_ID

OTHER = 'c5d2239e-4157-4fc9-8a12-0767e005ece9'
OTHER_KEY = 'a24c59d9-0dc9-49de-bcd1-2e52925cc010'
BASE = Connection('http://memory', 'test-memory-key', '', 'http://model/v1', 'test-model-key', 'test-model')


def row(uid=USER, owner=KEY_ID, label='原用户'):
    return {'id': uid, 'api_key_id': owner, 'status': 'active', 'display_name': label}


def run(store, scenario, remote=None, handler=None):
    remote = remote or Remote()
    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler or remote.handle)) as client:
            return await scenario(Connections(store, Providers(client)), remote)
    return asyncio.run(execute())


def test_legacy_single_user_reconnects_without_creation_and_persists_binding(mysql_store):
    async def scenario(connections, remote):
        first = await connections.validate(BASE)
        assert first.user_id == USER and first.ready() is None
        assert connections.binding(BASE.memory_url, KEY_ID) == USER
        second = await connections.validate(BASE)
        assert second == first
        assert not [c for c in remote.calls if c[:2] == ('POST', '/users')]
        assert all(c[4].get('x-api-key') == BASE.memory_key for c in remote.calls if c[1].startswith('/users'))
    run(mysql_store, scenario)


@pytest.mark.parametrize('existing', [[], [row(), row(OTHER)]])
def test_legacy_creates_one_marked_user_when_no_bound_or_recoverable_user_exists(mysql_store, existing):
    remote = Remote(); remote.users = existing
    async def scenario(connections, remote):
        chosen = await connections.validate(BASE)
        assert chosen.user_id not in {USER, OTHER}
        creations = [c for c in remote.calls if c[:2] == ('POST', '/users')]
        assert len(creations) == 1 and creations[0][2] == {'display_name': USER_LABEL, 'kb_enabled': False}
        assert connections.binding(BASE.memory_url, KEY_ID) == chosen.user_id
    run(mysql_store, scenario, remote)


@pytest.mark.parametrize('source', ['explicit', 'local', 'marker'])
def test_legacy_multiple_users_have_a_deterministic_validated_selection(mysql_store, source):
    remote = Remote(); remote.users = [row(), row(OTHER, label=USER_LABEL)]
    async def scenario(connections, remote):
        config = BASE
        if source == 'explicit': config = replace(BASE, user_id=OTHER)
        if source == 'local': connections.bind(replace(BASE, user_id=OTHER), KEY_ID)
        chosen = await connections.validate(config)
        assert chosen.user_id == OTHER
        assert not [c for c in remote.calls if c[:2] == ('POST', '/users')]
    run(mysql_store, scenario, remote)


@pytest.mark.parametrize('bad', [None, [], {}, {'items': [], 'total': True}, {'items': [], 'total': -1}, {'items': [row()], 'total': 0}, {'items': [None], 'total': 1}])
def test_legacy_directory_rejects_malformed_or_inconsistent_payload(mysql_store, bad):
    async def scenario(connections, remote):
        with pytest.raises(ServiceError) as failure: await connections.directory(BASE)
        assert failure.value.status == 502
    run(mysql_store, scenario, handler=lambda request: httpx.Response(200, json=bad))


@pytest.mark.parametrize('case,status', [('missing_key', 428), ('missing_model', 428), ('bound_conflict', 409), ('missing_fixed_user', 409), ('multiple_markers', 409), ('partial_markers', 409), ('wrong_marker_owner', 502), ('wrong_chosen_user', 409), ('wrong_chosen_owner', 409), ('wrong_created_owner', 502)])
def test_legacy_invalid_ownership_never_silently_rebinds_or_returns_success(mysql_store, case, status):
    remote = Remote(); config = BASE
    if case == 'missing_key': config = replace(BASE, memory_key='')
    if case == 'missing_model': config = replace(BASE, model='')
    if case == 'bound_conflict': config = replace(BASE, user_id=OTHER)
    if case == 'missing_fixed_user': remote.users = []; config = replace(BASE, user_id=USER)
    if case in {'multiple_markers', 'partial_markers', 'wrong_marker_owner', 'wrong_created_owner'}:
        remote.users = [row(), row(OTHER)]
    if case == 'multiple_markers': remote.users += [row(str(uuid.uuid4()), label=USER_LABEL), row(str(uuid.uuid4()), label=USER_LABEL)]
    if case == 'wrong_marker_owner': remote.users.append(row(str(uuid.uuid4()), OTHER_KEY, USER_LABEL))
    original = remote.handle
    def handle(request):
        response = original(request)
        if case == 'partial_markers' and request.url.path == '/users' and request.url.params.get('search'):
            return httpx.Response(200, json={'items': [row()], 'total': 1})
        if request.url.path.startswith('/users/') and case in {'wrong_chosen_user', 'wrong_chosen_owner'}:
            return httpx.Response(200, json=row(OTHER if case == 'wrong_chosen_user' else USER, OTHER_KEY if case == 'wrong_chosen_owner' else KEY_ID))
        if case == 'wrong_created_owner' and request.method == 'POST' and request.url.path == '/users':
            return httpx.Response(200, json=row(str(uuid.uuid4()), OTHER_KEY, USER_LABEL))
        return response
    async def scenario(connections, remote):
        if case == 'bound_conflict': connections.bind(replace(BASE, user_id=USER), KEY_ID)
        with pytest.raises(ServiceError) as failure: await connections.validate(config)
        assert failure.value.status == status
        assert connections.binding(BASE.memory_url, KEY_ID) == (USER if case == 'bound_conflict' else None)
    run(mysql_store, scenario, remote, handle)


def test_legacy_binding_unique_ownership_cannot_be_changed_by_either_side(mysql_store):
    connections = Connections(mysql_store, None)
    connections.bind(replace(BASE, user_id=USER), KEY_ID)
    with pytest.raises(ServiceError) as key_conflict: connections.bind(replace(BASE, user_id=OTHER), KEY_ID)
    assert key_conflict.value.status == 409
    with pytest.raises(ServiceError) as user_conflict: connections.bind(replace(BASE, user_id=USER), OTHER_KEY)
    assert user_conflict.value.status == 409
    assert connections.binding(BASE.memory_url, KEY_ID) == USER
    assert connections.binding(BASE.memory_url, OTHER_KEY) is None
