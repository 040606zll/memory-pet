"""账号归属连接：共享服务凭据下每个本地账号独立创建、恢复 MemoryOS 用户。"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from test_api import world, data, session, USER, KEY_ID, login
from pet.connections import user_record
from pet.errors import ServiceError
from pet.main import create_app


def creations(remote):
    return [call for call in remote.calls if call[0] == "POST" and call[1] == "/users"]


def fresh_account(client, username="fresh_account"):
    data(client.post("/api/auth/logout"))
    return login(client, username)


def test_first_connect_creates_once_and_reuses_after_logout_and_restart(world):
    client, remote, app = world
    account = fresh_account(client)
    first = data(client.post("/api/connection", json={}))
    uid = first["memoryos"]["user_id"]
    assert str(uuid.UUID(uid)) == uid and first["connected"] and uid != USER
    assert creations(remote)[0][2]["display_name"] == f"MemoryPet:{account['id']}"
    assert data(client.post("/api/connection", json={}))["memoryos"]["user_id"] == uid
    data(client.post("/api/auth/logout"))
    login(client, "fresh_account", register=False)
    assert data(client.get("/api/status"))["memoryos"]["user_id"] == uid
    restarted = create_app(database=app.state.store.config, connection=app.state.connection, transport=httpx.MockTransport(remote.handle))
    with TestClient(restarted) as next_client:
        login(next_client, "fresh_account", register=False)
        assert data(next_client.get("/api/status"))["memoryos"]["user_id"] == uid
    assert len(creations(remote)) == 1
    with app.state.store.db() as db:
        row = dict(db.execute("SELECT * FROM account_memory_bindings WHERE account_id=%s", (account["id"],)).fetchone())
    assert row["memory_user_id"] == uid and row["api_key_id"] == KEY_ID
    assert "memory-secret" not in str(row.values())


def test_shared_service_key_does_not_merge_users_or_claim_legacy_binding(world):
    client, remote, app = world
    account = fresh_account(client)
    with app.state.store.db() as db:
        db.execute("INSERT IGNORE INTO memory_user_bindings(service_url,service_hash,api_key_id,user_id) VALUES(%s,%s,%s,%s)", ("http://memory", hashlib.sha256(b"http://memory").digest(), KEY_ID, USER))
    first = data(client.post("/api/connection", json={}))["memoryos"]["user_id"]
    fresh_account(client, "second_account")
    second = data(client.post("/api/connection", json={}))["memoryos"]["user_id"]
    assert len({USER, first, second}) == 3
    assert len(creations(remote)) == 2
    assert all(c[4]["x-api-key"] == "memory-secret" for c in creations(remote))
    with app.state.store.db() as db:
        assert db.execute("SELECT count(*) AS total FROM account_memory_bindings WHERE api_key_id=%s", (KEY_ID,)).fetchone()["total"] == 3


def test_parallel_connect_only_creates_one_user(world):
    client, remote, _ = world
    fresh_account(client)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: data(client.post("/api/connection", json={})), range(2)))
    assert results[0]["memoryos"]["user_id"] == results[1]["memoryos"]["user_id"]
    assert len(creations(remote)) == 1


def test_create_response_lost_retry_recovers_stable_marked_user(world):
    client, remote, _ = world
    account = fresh_account(client)
    remote.user_response_lost = True
    assert client.post("/api/connection", json={}).status_code == 504
    assert len(creations(remote)) == 1
    uid = remote.users[-1]["id"]
    remote.user_response_lost = False
    assert data(client.post("/api/connection", json={}))["memoryos"]["user_id"] == uid
    assert len(creations(remote)) == 1
    assert remote.users[-1]["display_name"] == f"MemoryPet:{account['id']}"


def test_quota_failure_does_not_write_binding(world):
    client, remote, app = world
    account = fresh_account(client)
    remote.user_quota_exceeded = True
    result = client.post("/api/connection", json={})
    assert result.status_code == 422 and "额度" in result.json()["message"] and "secret" not in result.text
    with app.state.store.db() as db:
        row = db.execute("SELECT memory_user_id FROM account_memory_bindings WHERE account_id=%s", (account["id"],)).fetchone()
    assert row is None or not row["memory_user_id"]


@pytest.mark.parametrize("failure", ["key", "missing_model", "missing_memory_key", "not_ready"])
def test_unready_configuration_never_creates_remote_user(world, failure):
    client, remote, app = world
    fresh_account(client)
    if failure == "key":
        remote.error_path, remote.error_status = "/users", 401
    elif failure == "missing_model":
        app.state.connection = replace(app.state.connection, llm_key="")
    elif failure == "missing_memory_key":
        app.state.connection = replace(app.state.connection, memory_key="")
    else:
        original = remote.handle
        app.state.providers.client._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"status": "starting", "profile": "simple"}) if req.url.path == "/health/ready" else original(req))
    assert client.post("/api/connection", json={}).status_code in {428, 502, 503}
    assert not creations(remote)


def test_missing_or_disabled_bound_user_is_not_replaced(world):
    client, remote, _ = world
    remote.users = []
    assert client.post("/api/connection", json={}).status_code in {409, 502}
    remote.users = [{"id": USER, "api_key_id": KEY_ID, "status": "disabled"}]
    assert client.post("/api/connection", json={}).status_code == 409
    assert not creations(remote)


def test_ambiguous_account_markers_stop_without_new_creation(world):
    client, remote, _ = world
    account = fresh_account(client)
    remote.users = [{"id": str(uuid.uuid4()), "api_key_id": KEY_ID, "status": "active", "display_name": f"MemoryPet:{account['id']}"} for _ in range(2)]
    assert client.post("/api/connection", json={}).status_code == 409
    assert not creations(remote)


def test_connection_uses_authenticated_directory_without_anonymous_probe_or_model_call(world):
    client, remote, _ = world
    remote.directory_enforced = False
    fresh_account(client)
    assert data(client.post("/api/connection", json={}))["connected"]
    directory = [call for call in remote.calls if call[1] == "/users"]
    assert directory and all(call[4].get("x-api-key") == "memory-secret" for call in directory)
    assert not [call for call in remote.calls if call[1].endswith("chat/completions")]


@pytest.mark.parametrize("record", [None, {}, {"id": USER}, {"id": "invalid", "api_key_id": KEY_ID}, {"id": USER, "api_key_id": None}])
def test_user_contract_requires_real_uuid_and_key_owner(record):
    with pytest.raises(ServiceError, match="归属信息"):
        user_record(record)


def test_account_binding_unique_constraints_and_idempotent_initialization(world):
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy import inspect
    client, _, app = world
    account = fresh_account(client)
    app.state.store.initialize()
    assert {"local_accounts", "login_sessions", "account_memory_bindings"} <= set(inspect(app.state.store.engine).get_table_names())
    with pytest.raises(IntegrityError):
        with app.state.store.db() as db:
            db.execute("INSERT INTO account_memory_bindings(account_id,service_url,service_hash,memory_user_id,api_key_id) VALUES(%s,%s,%s,%s,%s)", (account["id"], "http://memory", hashlib.sha256(b"http://memory").digest(), USER, KEY_ID))


@pytest.mark.parametrize('payload', [[], {}, {'items':None,'total':0}, {'items':[],'total':True}])
def test_account_directory_contract_failure_releases_provisioning_lease(world, payload):
    client, remote, app = world
    account=fresh_account(client)
    original=remote.handle
    def handle(request):
        if request.method == 'GET' and request.url.path == '/users': return httpx.Response(200,json=payload)
        return original(request)
    app.state.providers.client._transport=httpx.MockTransport(handle)
    response=client.post('/api/connection',json={})
    assert response.status_code == 502
    with app.state.store.db() as db:
        binding=db.execute('SELECT * FROM account_memory_bindings WHERE account_id=%s',(account['id'],)).fetchone()
    assert binding['memory_user_id'] is None and binding['provision_owner'] is None and binding['lease_until'] == 0
