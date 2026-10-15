"""账号密码全链路回归：Cookie、CSRF、重启、延迟绑定、跨账号隔离。"""
from dataclasses import replace
import hashlib

import httpx
import pytest
from fastapi.testclient import TestClient

from test_api import Remote, data, login, session, chat, USER, KEY_ID, world
from pet.config import Connection
from pet.main import create_app


@pytest.fixture
def isolated(mysql_config):
    remote = Remote()
    config = Connection("http://memory", "memory-secret", USER, "http://model", "llm-secret", "model")
    app = create_app(database=mysql_config, connection=config, transport=httpx.MockTransport(remote.handle))
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, remote, app


@pytest.mark.parametrize("method,path,payload", [
    ("GET", "/api/auth/me", None), ("GET", "/api/status", None),
    ("POST", "/api/connection", {}), ("POST", "/api/disconnect", None),
    ("GET", "/api/sessions", None), ("POST", "/api/sessions", {}),
    ("PATCH", "/api/sessions/unknown", {"mode": "chat"}),
    ("GET", "/api/sessions/unknown/messages", None),
    ("POST", "/api/sessions/unknown/chat", {"content": "你好", "request_id": "req"}),
    ("PATCH", "/api/sessions/unknown/candidates/unknown", {"content": "新内容"}),
    ("POST", "/api/sessions/unknown/memories/confirm", {"candidate_id": "unknown"}),
    ("GET", "/api/sessions/unknown/memories", None), ("POST", "/api/auth/logout", None),
])
def test_all_business_endpoints_require_login(isolated, method, path, payload):
    client, remote, _ = isolated
    response = client.request(method, path, json=payload)
    assert response.status_code == 401 and response.json()["data"] is None
    assert not remote.calls
    assert data(client.get("/api/health"))["status"] == "ok"


def test_registration_login_cookie_hash_and_no_remote_call(isolated):
    client, remote, app = isolated
    result = client.post("/api/auth/register", json={"username": "Alice_01", "password": "Test-password-123"})
    auth = data(result)
    assert auth["user"]["username"] == "alice_01" and auth["csrf_token"]
    cookie = result.headers["set-cookie"].lower()
    assert "memory_pet_session=" in cookie and "httponly" in cookie and "samesite=strict" in cookie and "path=/" in cookie
    token = client.cookies.get("memory_pet_session")
    assert token and len(token) >= 32
    with app.state.store.db() as db:
        account = dict(db.execute("SELECT * FROM local_accounts").fetchone())
        login_row = dict(db.execute("SELECT * FROM login_sessions").fetchone())
    assert account["password_hash"] != "Test-password-123"
    assert "Test-password-123" not in account["password_hash"]
    assert login_row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in str(login_row.values())
    assert not remote.calls
    assert data(client.get("/api/auth/me")) == auth
    client.headers["X-CSRF-Token"] = auth["csrf_token"]
    data(client.post("/api/auth/logout"))
    assert client.get("/api/auth/me").status_code == 401
    next_auth = data(client.post("/api/auth/login", json={"username": "ALICE_01", "password": "Test-password-123"}))
    assert next_auth["user"] == auth["user"] and next_auth["csrf_token"] != auth["csrf_token"]
    assert not remote.calls


def test_password_hashes_use_unique_salt_and_validate():
    from pet.auth import hash_password, verify_password
    first, second = hash_password("password-123"), hash_password("password-123")
    assert first != second
    assert verify_password("password-123", first)
    assert not verify_password("wrong-password", first)
    assert not verify_password("password-123", "not-a-password-hash")


@pytest.mark.parametrize("username,password", [("a", "long-password"), ("abc", "short"), ("含中文", "long-password"), ("a" * 33, "long-password"), ("valid", "a" * 129)])
def test_invalid_registration_is_rejected_without_remote_call(isolated, username, password):
    client, remote, _ = isolated
    assert client.post("/api/auth/register", json={"username": username, "password": password}).status_code == 422
    assert not remote.calls


def test_duplicate_username_login_failure_and_login_rate_limit(isolated):
    client, _, _ = isolated
    login(client)
    repeated = client.post("/api/auth/register", json={"username": "TESTER", "password": "another-password"})
    assert repeated.status_code == 409
    data(client.post("/api/auth/logout"))
    wrong = client.post("/api/auth/login", json={"username": "tester", "password": "wrong-password"})
    missing = client.post("/api/auth/login", json={"username": "missing_user", "password": "wrong-password"})
    assert wrong.status_code == missing.status_code == 401
    assert wrong.json()["message"] == missing.json()["message"]
    statuses = [client.post("/api/auth/login", json={"username": "tester", "password": "wrong-password"}).status_code for _ in range(20)]
    assert 429 in statuses and client.get("/api/auth/me").status_code == 401


@pytest.mark.parametrize("method,path,payload", [("POST", "/api/connection", {}), ("POST", "/api/sessions", {}), ("POST", "/api/disconnect", None), ("POST", "/api/auth/logout", None)])
def test_authenticated_mutations_require_correct_csrf(isolated, method, path, payload):
    client, remote, _ = isolated
    login(client)
    csrf = client.headers.pop("X-CSRF-Token")
    assert client.request(method, path, json=payload).status_code == 403
    client.headers["X-CSRF-Token"] = "wrong-token"
    assert client.request(method, path, json=payload).status_code == 403
    assert not remote.calls
    client.headers["X-CSRF-Token"] = csrf
    assert data(client.get("/api/auth/me"))["csrf_token"] == csrf


def test_restart_preserves_session_and_expiry_revokes_it(isolated):
    client, remote, app = isolated
    user = login(client)
    token = client.cookies.get("memory_pet_session")
    restarted = create_app(database=app.state.store.config, connection=app.state.connection, transport=httpx.MockTransport(remote.handle))
    with TestClient(restarted) as next_client:
        next_client.cookies.set("memory_pet_session", token)
        assert data(next_client.get("/api/auth/me"))["user"] == user
        with app.state.store.db() as db:
            db.execute("UPDATE login_sessions SET expires_at=0")
        assert next_client.get("/api/auth/me").status_code == 401
    assert client.get("/api/status").status_code == 401


def test_upstream_outage_does_not_block_registration_login_or_expose_credentials(isolated):
    client, remote, app = isolated
    remote.error_path, remote.error_status = "/users", 401
    login(client)
    assert not remote.calls
    status = data(client.get("/api/status"))
    assert not status["connected"] and status["memory_error"] and any(word in status["memory_error"] for word in ("鉴权失败", "凭据"))
    failure = client.post("/api/connection", json={})
    assert failure.status_code in {502, 503} and any(word in failure.json()["message"] for word in ("鉴权失败", "凭据"))
    assert "secret" not in failure.text and "秘密" not in failure.text
    remote.error_path = None
    assert data(client.post("/api/connection", json={}))["connected"]
    assert len([r for r in remote.calls if r[:2] == ("POST", "/users")]) == 1


@pytest.mark.parametrize("profile", ["simple", "development", None])
def test_ready_profile_does_not_replace_real_permission_checks(isolated, profile):
    client, remote, app = isolated
    login(client)
    original = remote.handle
    app.state.providers.client._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"status": "ready", "profile": profile}) if req.url.path == "/health/ready" else original(req))
    status = data(client.get("/api/status"))
    assert status["connected"] and status["memory_error"] is None
    assert data(client.post("/api/connection", json={}))["connected"]
    assert len([r for r in remote.calls if r[:2] == ("POST", "/users")]) == 1
    assert all(r[4].get("x-api-key") for r in remote.calls if r[1].startswith("/users"))


@pytest.mark.parametrize("profile", ["production", "simple"])
def test_two_accounts_training_recall_and_every_cross_account_path(isolated, profile):
    client, remote, app = isolated
    original = remote.handle
    app.state.providers.client._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"status": "ready", "profile": profile}) if req.url.path == "/health/ready" else original(req))
    first = login(client, "alice")
    data(client.get("/api/status"))
    old_sid = session(client)
    cid = chat(client, old_sid)["assistant_message"]["candidates"][0]["id"]
    confirmed = data(client.post(f"/api/sessions/{old_sid}/memories/confirm", json={"candidate_id": cid}))
    alice_uid = data(client.get("/api/status"))["memoryos"]["user_id"]
    data(client.post("/api/auth/logout"))
    second = login(client, "bob")
    bob_uid = data(client.get("/api/status"))["memoryos"]["user_id"]
    assert first["id"] != second["id"] and alice_uid != bob_uid
    assert data(client.get("/api/sessions"))["total"] == 0
    before = len([r for r in remote.calls if r[1] in {"/recall", "/ingest"} or r[1].endswith("chat/completions")])
    for method, suffix, body in [("GET", "/messages", None), ("GET", "/memories", None), ("PATCH", "", {"mode": "chat"}), ("POST", "/chat", {"content": "越权消息", "request_id": "attack"}), ("PATCH", f"/candidates/{cid}", {"content": "越权修改"}), ("POST", "/memories/confirm", {"candidate_id": cid})]:
        assert client.request(method, f"/api/sessions/{old_sid}{suffix}", json=body).status_code == 404
    assert len([r for r in remote.calls if r[1] in {"/recall", "/ingest"} or r[1].endswith("chat/completions")]) == before
    bob_sid = session(client, "chat")
    assert chat(client, bob_sid, "我喜欢什么？", "bob-recall")["assistant_message"]["memories"] == []
    # 仅伪造候选编号也不能通过另一个归属正确的会话访问。
    assert client.post(f"/api/sessions/{bob_sid}/memories/confirm", json={"candidate_id": cid}).status_code == 404
    remote.reply["candidates"] = ["用户喜欢蓝莓"]
    bob_train = session(client)
    bob_cid = chat(client, bob_train)["assistant_message"]["candidates"][0]["id"]
    data(client.post(f"/api/sessions/{bob_train}/memories/confirm", json={"candidate_id": bob_cid}))
    data(client.post("/api/auth/logout"))
    login(client, "alice", register=False)
    recalled = chat(client, session(client, "chat"), "我喜欢什么？", "alice-recall")["assistant_message"]["memories"]
    assert {m["id"] for m in recalled} == set(confirmed["memory_ids"])
    assert all(r[2]["user_id"] in {alice_uid, bob_uid} for r in remote.calls if r[1] in {"/recall", "/ingest"})


def test_legacy_session_is_preserved_but_never_claimed_by_new_account(isolated):
    client, _, app = isolated
    old = app.state.store.create_session(app.state.connection.scope, "chat", "旧会话")
    login(client)
    assert data(client.get("/api/sessions"))["total"] == 0
    assert client.get(f"/api/sessions/{old['id']}/messages").status_code == 404
    with app.state.store.db() as db:
        assert db.execute("SELECT title FROM sessions WHERE id=%s", (old["id"],)).fetchone()["title"] == "旧会话"


def test_https_cookie_is_secure_and_successful_login_rotates_old_session(isolated):
    client, remote, app = isolated
    login(client)
    old_token = client.cookies.get("memory_pet_session")
    result = client.post("/api/auth/login", json={"username": "tester", "password": "Test-password-123"})
    auth = data(result)
    assert client.cookies.get("memory_pet_session") != old_token
    with app.state.store.db() as db:
        assert db.execute("SELECT count(*) AS total FROM login_sessions WHERE token_hash=%s", (hashlib.sha256(old_token.encode()).hexdigest(),)).fetchone()["total"] == 0
    client.cookies.clear()
    client.cookies.set("memory_pet_session", old_token)
    assert client.get("/api/auth/me").status_code == 401
    with TestClient(app, base_url="https://localhost") as secure:
        result = secure.post("/api/auth/login", json={"username": "tester", "password": "Test-password-123"})
        assert result.status_code == 200 and "; secure" in result.headers["set-cookie"].lower()


@pytest.mark.parametrize("token", ["forged-token", "x" * 257])
def test_forged_or_oversized_cookie_is_rejected(isolated, token):
    client, remote, _ = isolated
    client.cookies.set("memory_pet_session", token)
    assert client.get("/api/status").status_code == 401
    assert not remote.calls


def test_registration_rate_limit_is_shared_across_usernames(isolated):
    client, _, _ = isolated
    # 已有窗口耗尽时，更换用户名也不能绕过来源地址限流。
    app = client.app
    bucket = f"register:ip:{app.state.accounts.digest('testclient')}"
    with app.state.store.db() as db:
        import time
        db.execute("INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(%s,%s,%s)", (bucket, 30, int(time.time()) + 900))
    assert client.post("/api/auth/register", json={"username": "new_account", "password": "Test-password-123"}).status_code == 429
