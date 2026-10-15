"""账号登录后连接仅由服务端凭据建立；旧页面传 Key 的入口已关闭。"""
from dataclasses import replace
import uuid

import httpx

from test_api import world, data, session, chat, USER, KEY_ID


def connect(client):
    return client.post("/api/connection", json={})


def assert_no_anonymous_directory_request(remote):
    calls = [call for call in remote.calls if call[1].startswith("/users")]
    assert calls and all(call[4].get("x-api-key") for call in calls)


def test_anonymous_directory_readability_does_not_block_authenticated_connection(world):
    client, remote, app = world
    remote.directory_enforced = False
    assert data(connect(client))["memoryos"]["user_id"] == USER
    assert_no_anonymous_directory_request(remote)
    with app.state.store.db() as db:
        assert db.execute("SELECT memory_user_id FROM account_memory_bindings").fetchone()["memory_user_id"] == USER


def test_browser_cannot_supply_legacy_key_or_fixed_user(world):
    client, remote, app = world
    before = len(remote.calls)
    for body in ({"memoryos": {"base_url": "http://memory"}}, {"api_key": "browser-key"}, {"user_id": USER}):
        assert client.post("/api/connection", json=body).status_code == 422
    assert len(remote.calls) == before


def test_actual_upstream_authentication_failure_is_preserved(world):
    client, remote, app = world
    remote.error_path, remote.error_status = f"/users/{USER}", 401
    result = connect(client)
    assert result.status_code in {502, 503} and any(word in result.json()["message"] for word in ("鉴权失败", "凭据"))
    assert not [call for call in remote.calls if call[1].endswith("chat/completions")]
    assert_no_anonymous_directory_request(remote)


def test_missing_user_owner_information_is_still_rejected(world):
    client, remote, _ = world
    remote.users[0]["api_key_id"] = None
    result = connect(client)
    assert result.status_code == 502 and "归属" in result.json()["message"]
    assert_no_anonymous_directory_request(remote)


def test_inconsistent_user_owner_is_still_rejected(world):
    client, remote, app = world
    handler = remote.handle
    def mismatched_user(request):
        response = handler(request)
        if request.url.path == f"/users/{USER}":
            return httpx.Response(200, json={**response.json(), "api_key_id": str(uuid.uuid4())})
        return response
    app.state.providers.client._transport = httpx.MockTransport(mismatched_user)
    result = connect(client)
    assert result.status_code == 409
    assert_no_anonymous_directory_request(remote)


def test_training_confirmation_and_new_session_recall_continue_without_probe(world):
    client, remote, _ = world
    remote.directory_enforced = False
    assert data(connect(client))["connected"]
    training = session(client)
    candidate = chat(client, training)["assistant_message"]["candidates"][0]
    confirmed = data(client.post(f"/api/sessions/{training}/memories/confirm", json={"candidate_id": candidate["id"]}))
    formal = session(client, "chat")
    recalled = chat(client, formal, "我喜欢喝什么？", "new-session")
    assert recalled["assistant_message"]["memories"][0]["id"] in confirmed["memory_ids"]
    assert_no_anonymous_directory_request(remote)
