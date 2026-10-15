"""健康服务不以部署模式名称判断能否连接，真实用户和权限仍逐项校验。"""
from pathlib import Path
import sys

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[5] / 'tests' / 'backend'))
from test_api import world, data, session


@pytest.mark.parametrize('profile', ['simple', 'development', None])
def test_ready_profile_does_not_block_account_memory_connection(world, profile):
    client, remote, app = world
    original = remote.handle
    def handle(request):
        if request.url.path == '/health/ready':
            return httpx.Response(200, json={'status': 'ready', **({'profile': profile} if profile is not None else {})})
        return original(request)
    app.state.providers.client._transport = httpx.MockTransport(handle)
    status = data(client.get('/api/status'))
    assert status['connected'], status['memory_error']
    assert '生产鉴权模式' not in str(status)
    assert data(client.post('/api/connection', json={}))['connected']
    assert session(client)


def test_simple_profile_still_rejects_invalid_service_credentials(world):
    client, remote, app = world
    original = remote.handle
    def handle(request):
        if request.url.path == '/health/ready':
            return httpx.Response(200, json={'status': 'ready', 'profile': 'simple'})
        return original(request)
    app.state.providers.client._transport = httpx.MockTransport(handle)
    remote.error_path = '/users/' + remote.users[0]['id']
    remote.error_status = 401
    result = client.post('/api/connection', json={})
    assert result.status_code == 503
    assert '凭据' in result.json()['message']
    assert '生产鉴权模式' not in result.text
