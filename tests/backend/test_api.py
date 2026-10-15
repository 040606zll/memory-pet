"""HTTP 层链路回归：真实 MemoryOS/兼容模型响应形状由传输层替身模拟。"""
import asyncio
import hashlib
from dataclasses import replace
import json
import sys
from pathlib import Path
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from pet.actions import commands, resolve_actions
from pet.config import Connection, validated_url
from pet.errors import ServiceError
from pet.main import create_app
from pet.schemas import ChatBody, ModelOutput
from pet.service import PetService

USER = "a8309e08-77b0-41c3-94f4-5b319d7d6396"
KEY_ID = "981269dd-c4b3-4ae0-9399-ef63ec6ecc74"


class Remote:
    def __init__(self):
        self.calls, self.saved, self.sources = [], [], {}
        self.reply = {"reply": "我会陪着你，训练内容等你确认。", "emotion": "happy", "actions": ["wave"], "candidates": ["用户喜欢喝绿茶"]}
        self.error_path = None
        self.error_status = 503
        self.malformed = False
        self.skip = False
        self.conflict = False
        self.recall = []
        self.timeout = False
        self.users = [{"id": USER, "api_key_id": KEY_ID, "status": "active", "display_name": "原用户"}]
        self.user_quota_exceeded = False
        self.user_response_lost = False
        self.directory_enforced = True

    def handle(self, req):
        body = json.loads(req.content) if req.content else None
        self.calls.append((req.method, req.url.path, body, dict(req.url.params), dict(req.headers)))
        if self.timeout:
            raise httpx.ReadTimeout("保密详情不应该返回", request=req)
        if self.error_path == req.url.path:
            return httpx.Response(self.error_status, json={"detail": "秘密敏感上游堆栈"})
        if req.url.path == "/health/ready":
            return httpx.Response(200, json={"status": "ready", "profile": "production"})
        if req.url.path == "/users":
            if not req.headers.get("x-api-key") and self.directory_enforced:
                return httpx.Response(401, json={"detail": "需要身份验证"})
            if req.method == "POST":
                if self.user_quota_exceeded:
                    return httpx.Response(403, json={"detail": "QUOTA_EXCEEDED: secret-quota"})
                row = {"id": str(uuid.uuid4()), "api_key_id": KEY_ID, "status": "active", "display_name": body["display_name"]}
                self.users.append(row)
                if self.user_response_lost:
                    raise httpx.ReadTimeout("模拟用户创建成功但响应丢失", request=req)
                return httpx.Response(200, json=row)
            search = req.url.params.get("search", "")
            rows = [row for row in self.users if search in (row.get("display_name") or "")]
            start = int(req.url.params.get("offset", 0))
            limit = int(req.url.params.get("limit", 2))
            return httpx.Response(200, json={"items": rows[start:start + limit], "total": len(rows)})
        if req.url.path.startswith("/users/"):
            row = next((row for row in self.users if row["id"] == req.url.path.rsplit("/", 1)[1]), None)
            return httpx.Response(200 if row else 404, json=row or {"detail": "USER_NOT_FOUND"})
        if req.url.path == "/memories":
            q = req.url.params.get("q")
            rows = [m for m in self.saved if m.get("user_id", req.url.params.get("user_id")) == req.url.params.get("user_id") and (not q or q in m["content"])]
            start = (int(req.url.params["page"]) - 1) * int(req.url.params["limit"])
            return httpx.Response(200, json=rows[start:start + int(req.url.params["limit"])])
        if req.url.path == "/recall":
            rows = [m for m in self.saved if m.get("user_id", body["user_id"]) == body["user_id"]]
            return httpx.Response(200, json={"facts": self.recall or rows[:5], "associations": [], "source_hits": {"long_term": rows}})
        if req.url.path.endswith("/chat/completions"):
            content = "不是JSON" if self.malformed else json.dumps(self.reply, ensure_ascii=False)
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]})
        if req.url.path == "/ingest":
            if self.conflict:
                return httpx.Response(200, json={"memory_ids": [], "conflicts": [{"id": "conflict"}]})
            if self.skip:
                return httpx.Response(200, json={"memory_ids": [], "skipped": True})
            if body["source_id"] not in self.sources:
                mid = str(uuid.uuid4())
                self.saved.append({"user_id": body["user_id"], "memory_id": mid, "content": body["text"], "status": "active", "created_at": "2026-10-14T01:00:00Z", "evidence": [{"source": body["source"]}]})
                self.sources[body["source_id"]] = mid
            return httpx.Response(200, json={"memory_ids": [self.sources[body["source_id"]]], "conflicts": [], "skipped": False})
        raise AssertionError(req.url)


@pytest.fixture
def world(mysql_config):
    remote = Remote()
    config = Connection("http://memory", "memory-secret", USER, "https://api.deepseek.com", "llm-secret", "deepseek-model")
    app = create_app(database=mysql_config, connection=config, transport=httpx.MockTransport(remote.handle))
    with TestClient(app, raise_server_exceptions=False) as client:
        login(client)
        bind_existing(app, client, USER)
        yield client, remote, app


def data(resp):
    assert resp.status_code == 200, resp.text
    assert resp.json()["code"] == 0
    return resp.json()["data"]


def session(client, mode="training"):
    return data(client.post("/api/sessions", json={"mode": mode}))["id"]


def chat(client, sid, content="我喜欢喝绿茶，眨眨眼", rid="test-1"):
    return data(client.post(f"/api/sessions/{sid}/chat", json={"content": content, "request_id": rid}))


def login(client, username="tester", password="Test-password-123", register=True):
    endpoint = "register" if register else "login"
    result = data(client.post(f"/api/auth/{endpoint}", json={"username": username, "password": password}))
    client.headers["X-CSRF-Token"] = result["csrf_token"]
    return result["user"]


def bind_existing(app, client, memory_user_id):
    account = data(client.get("/api/auth/me"))["user"]
    with app.state.store.db() as db:
        db.execute("REPLACE INTO account_memory_bindings(account_id,service_url,service_hash,memory_user_id,api_key_id) VALUES(%s,%s,%s,%s,%s)",
                   (account["id"], app.state.connection.memory_url, hashlib.sha256(app.state.connection.memory_url.encode()).digest(), memory_user_id, KEY_ID))


def account_connection(app, client):
    user = data(client.get("/api/auth/me"))["user"]
    with app.state.store.db() as db:
        row = db.execute("SELECT memory_user_id FROM account_memory_bindings WHERE account_id=%s AND service_url=%s", (user["id"], app.state.connection.memory_url)).fetchone()
    return replace(app.state.connection, user_id=row["memory_user_id"], local_account_id=user["id"])


def connect_body():
    return {}


def test_full_training_confirmation_and_cross_session_recall(world):
    client, remote, app = world
    assert data(client.get("/api/status"))["connected"] is True
    status = data(client.post("/api/connection", json=connect_body()))
    assert status["connected"] and status["llm_validated"] and status["memory_validated"]
    assert status["llm"] == {"configured": True}
    assert "secret" not in json.dumps(status)
    sid = session(client)
    result = chat(client, sid)
    assistant = result["assistant_message"]
    assert assistant["actions"] == [{"name": "blink", "trigger": "explicit", "duration_ms": 900}]
    candidate = assistant["candidates"][0]
    cid = candidate["id"]
    data(client.patch(f"/api/sessions/{sid}/candidates/{cid}", json={"content": "用户喜欢喝乌龙茶"}))
    confirmation = data(client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": cid}))
    assert confirmation["status"] == "confirmed" and confirmation["memory_ids"]
    repeated = data(client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": cid}))
    assert repeated == confirmation
    assert len([c for c in remote.calls if c[1] == "/ingest"]) == 1
    replay = chat(client, sid)
    assert replay["assistant_message"]["candidates"][0]["status"] == "confirmed"
    assert data(client.get(f"/api/sessions/{sid}/messages"))["items"][1]["candidates"][0]["content"] == "用户喜欢喝乌龙茶"
    second = session(client, "chat")
    answer = chat(client, second, "我喜欢喝什么茶？", "next-session")["assistant_message"]
    assert answer["memories"][0]["content"] == "用户喜欢喝乌龙茶"
    assert answer["memories"][0]["source"] == "熊猫宠物训练"
    assert answer["candidates"] == []
    model_calls = [c for c in remote.calls if c[1].endswith("chat/completions")]
    assert "用户喜欢喝乌龙茶" in model_calls[-1][2]["messages"][1]["content"]
    assert model_calls[-1][2]["thinking"] == {"type": "disabled"}
    assert model_calls[-1][4]["authorization"] == "Bearer llm-secret"
    recall_call = [c for c in remote.calls if c[1] == "/recall"][-1]
    assert recall_call[4]["x-api-key"] == "memory-secret"
    assert "session_id" not in recall_call[2]
    memories = data(client.get(f"/api/sessions/{second}/memories"))
    assert memories["total"] == memories["total_pages"] == 1


def test_reject_edit_rules_and_missing_candidate(world):
    client, remote, app = world
    sid = session(client)
    cid = chat(client, sid)["assistant_message"]["candidates"][0]["id"]
    route = f"/api/sessions/{sid}/candidates/{cid}"
    assert client.patch(route, json={}).status_code == 400
    assert client.patch(route, json={"content": "   "}).status_code == 400
    assert data(client.patch(route, json={"status": "rejected"}))["status"] == "rejected"
    assert client.patch(route, json={"content": "新内容"}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": cid}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": "不存在"}).status_code == 404
    assert not remote.saved


def test_idempotent_message_conflict_and_mode(world):
    client, remote, app = world
    sid = session(client)
    first = chat(client, sid)
    assert chat(client, sid) == first
    assert len(data(client.get(f"/api/sessions/{sid}/messages"))["items"]) == 2
    assert client.post(f"/api/sessions/{sid}/chat", json={"content": "不同内容", "request_id": "test-1"}).status_code == 409
    assert data(client.patch(f"/api/sessions/{sid}", json={"mode": "chat"}))["mode"] == "chat"
    assert client.post(f"/api/sessions/{sid}/chat", json={"content": "我喜欢喝绿茶，眨眨眼", "request_id": "test-1"}).status_code == 409
    assert chat(client, sid, rid="test-2")["assistant_message"]["candidates"] == []


@pytest.mark.parametrize("path,status", [("/recall", 401), ("/recall", 500), ("/chat/completions", 503)])
def test_model_memory_failures_are_clear_retryable(world, path, status):
    client, remote, app = world
    sid = session(client)
    remote.error_path, remote.error_status = path, status
    failed = client.post(f"/api/sessions/{sid}/chat", json={"content": "你好", "request_id": "same"})
    assert failed.status_code == 502
    assert "秘密" not in failed.text and "secret" not in failed.text
    assert data(client.get(f"/api/sessions/{sid}/messages"))["total"] == 0
    remote.error_path = None
    chat(client, sid, "你好", "same")
    assert data(client.get(f"/api/sessions/{sid}/messages"))["total"] == 2


def test_malformed_model_and_timeout(world):
    client, remote, app = world
    sid = session(client)
    remote.malformed = True
    assert client.post(f"/api/sessions/{sid}/chat", json={"content": "你好", "request_id": "same"}).status_code == 502
    remote.malformed = False
    remote.timeout = True
    assert client.post(f"/api/sessions/{sid}/chat", json={"content": "你好", "request_id": "same"}).status_code == 504
    remote.timeout = False
    assert data(client.get(f"/api/sessions/{sid}/messages"))["total"] == 0


@pytest.mark.parametrize("kind,status", [("skip", 422), ("conflict", 409)])
def test_confirmation_never_fakes_success(world, kind, status):
    client, remote, app = world
    sid = session(client)
    cid = chat(client, sid)["assistant_message"]["candidates"][0]["id"]
    setattr(remote, kind, True)
    assert client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": cid}).status_code == status
    assert data(client.get(f"/api/sessions/{sid}/messages"))["items"][1]["candidates"][0]["status"] == "pending"
    setattr(remote, kind, False)
    assert data(client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": cid}))["status"] == "confirmed"


def test_connection_rejects_browser_overrides_and_disconnect_keeps_server_config(world):
    client, remote, app = world
    original = app.state.connection
    for body in ({"memoryos": {"api_key": "new-secret"}}, {"memoryos": {"user_id": USER}}, {"memoryos": {"base_url": "http://other"}}):
        assert client.post("/api/connection", json=body).status_code == 422
    assert app.state.connection == original
    sid = session(client)
    assert client.post("/api/disconnect").status_code == 409
    assert app.state.connection == original
    assert data(client.post("/api/connection", json={}))['connected']
    assert data(client.get(f"/api/sessions/{sid}/messages"))["total"] == 0


def test_pagination_scope_and_cross_site(world):
    client, remote, app = world
    sid = session(client)
    session(client, "chat")
    assert data(client.get("/api/sessions?limit=1"))["total_pages"] == 2
    assert data(client.get("/api/sessions?mode=chat"))["total"] == 1
    chat(client, sid)
    assert data(client.get(f"/api/sessions/{sid}/messages?limit=1&page=2"))["items"][0]["role"] == "assistant"
    remote.saved = [{"memory_id": str(i), "content": f"乌龙茶{i}"} for i in range(205)]
    page = data(client.get(f"/api/sessions/{sid}/memories?page=3&limit=20&q=乌龙"))
    assert page["total"] == 205 and page["total_pages"] == 11 and len(page["items"]) == 20
    assert client.get("/api/status", headers={"origin": "https://evil.test"}).status_code == 403
    assert client.get("/api/status", headers={"host": "evil.test"}).status_code == 403
    assert client.get("/api/status", headers={"sec-fetch-site": "cross-site"}).status_code == 403
    assert client.get(f"/api/sessions/{sid}/messages?limit=0").status_code == 422
    assert client.post(f"/api/sessions/{sid}/chat", json={"content": "  ", "request_id": "bad"}).status_code == 422
    assert data(client.get("/api/health"))["status"] == "ok"
    # 更换账号后，本地历史不可越权读取。
    data(client.post("/api/auth/logout"))
    login(client, "another")
    assert client.get(f"/api/sessions/{sid}/messages").status_code == 404


@pytest.mark.parametrize("text,names,forbidden", [("眨眨眼，然后挥挥手", ["blink", "wave"], set()), ("不要眨眼，点点头", ["nod"], {"blink"}), ("昨天你伸懒腰了", [], set()), ("别睡觉也不要摇头", [], {"sleep", "shake_head"}), ("伸个懒腰", ["stretch"], set())])
def test_action_semantics(text, names, forbidden):
    assert commands(text) == (names, forbidden)
    result = resolve_actions(text, ModelOutput(reply="好", emotion="happy", actions=["blink", "sleep"]))
    assert all(a["name"] not in forbidden for a in result)
    if names:
        assert [a["name"] for a in result] == names and result[0]["trigger"] == "explicit"


def test_emotion_actions_and_config_guards():
    assert resolve_actions("你好", ModelOutput(reply="好", emotion="happy"))[0]["name"] == "happy"
    assert resolve_actions("你好", ModelOutput(reply="好", emotion="neutral")) == []
    for url in ["file:///tmp/test", "https://server?key=secret", "https://server#key"]:
        with pytest.raises(ServiceError):
            validated_url(url)
    assert validated_url(" https://server/v1/ ") == "https://server/v1"
    with pytest.raises(ServiceError):
        Connection().ready()
    with pytest.raises(ServiceError):
        Connection(memory_key="key", user_id=USER).ready()
    with pytest.raises(Exception):
        ModelOutput(reply="好", candidates=[""])


def test_validated_key_rotation_preserves_history(world):
    client, remote, app = world
    sid = session(client)
    chat(client, sid)
    app.state.connection = replace(app.state.connection, memory_key="rotated-key")
    assert data(client.post("/api/connection", json={}))["connected"]
    assert data(client.get(f"/api/sessions/{sid}/messages"))["total"] == 2
    assert data(client.get("/api/sessions"))["items"][0]["id"] == sid


def test_unvalidated_key_cannot_read_existing_history(world):
    client, remote, app = world
    sid = session(client)
    chat(client, sid)
    app.state.connection = Connection("http://memory", "invalid-key", USER, "http://model", "key", "model")
    remote.error_path, remote.error_status = f"/users/{USER}", 401
    denied = client.get(f"/api/sessions/{sid}/messages")
    assert denied.status_code in {502, 503} and any(word in denied.json()["message"] for word in ("鉴权失败", "凭据"))


def test_cancellation_releases_state_and_model_does_not_hold_db(world):
    client, remote, app = world
    config = account_connection(app, client)
    sid = session(client)
    store = app.state.store

    async def scenario():
        started = asyncio.Event()
        finish = asyncio.Event()

        class SlowProviders:
            async def recall(self, *args):
                return []

            async def reply(self, *args):
                started.set()
                await finish.wait()
                return ModelOutput(reply="你好")

        service = PetService(store, SlowProviders())
        body = ChatBody(content="你好", request_id="cancelled")
        task = asyncio.create_task(service.chat(config, sid, body))
        await asyncio.wait_for(started.wait(), 1)
        # 模型挂起时另一个真实 MySQL 连接可直接写入，连接池占用验证见专用回归。
        with store.db() as db:
            db.execute("UPDATE sessions SET title=%s WHERE id=%s", ("没有长事务", sid))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with store.db() as db:
            assert db.execute("SELECT state FROM operations WHERE id=%s", (f"{sid}:cancelled",)).fetchone()["state"] == "failed"
        assert store.messages(sid, config.scope)["total"] == 0
        finish.set()
        result = await service.chat(config, sid, body)
        assert result["assistant_message"]["content"] == "你好"

    asyncio.run(scenario())


def test_disconnect_monitor_cancels_coroutine():
    from pet.main import disconnect_aware

    async def scenario():
        cancelled = asyncio.Event()

        class Disconnected:
            async def is_disconnected(self):
                return True

        async def blocked():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with pytest.raises(ServiceError) as exc:
            await disconnect_aware(Disconnected(), blocked())
        assert exc.value.status == 499 and cancelled.is_set()

    asyncio.run(scenario())


def test_corrupt_upstream_structures_and_readiness(world):
    client, remote, app = world
    sid = session(client)
    original = remote.handle

    def corrupt(req):
        if req.url.path in {"/recall", "/memories", "/ingest"}:
            return httpx.Response(200, json={"unexpected": True})
        return original(req)

    app.state.providers.client._transport = httpx.MockTransport(corrupt)
    assert client.post(f"/api/sessions/{sid}/chat", json={"content": "你好", "request_id": "bad"}).status_code == 502
    assert client.get(f"/api/sessions/{sid}/memories").status_code == 502
    app.state.providers.client._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"status": "degraded"}) if req.url.path == "/health/ready" else original(req))
    assert client.post("/api/connection", json=connect_body()).status_code == 503


def test_custom_pet_name_is_in_real_model_request_and_idempotence(world):
    client, remote, app = world
    sid = session(client)
    body = {"content": "你好", "request_id": "named", "pet_name": "圆圆"}
    data(client.post(f"/api/sessions/{sid}/chat", json=body))
    prompt = [c for c in remote.calls if c[1].endswith("chat/completions")][-1][2]["messages"][0]["content"]
    assert "圆圆" in prompt
    body["pet_name"] = "小忆"
    assert client.post(f"/api/sessions/{sid}/chat", json=body).status_code == 409


def test_candidate_replay_database_queries_are_constant(world):
    from sqlalchemy import event
    client, remote, app = world
    counts = []
    for count in (1, 5):
        remote.reply["candidates"] = [f"用户喜欢第{i}种茶" for i in range(count)]
        sid = session(client)
        chat(client, sid)
        statements = []

        def before_execute(conn, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(app.state.store.engine, "before_cursor_execute", before_execute)
        try:
            chat(client, sid)
        finally:
            event.remove(app.state.store.engine, "before_cursor_execute", before_execute)
        counts.append(len(statements))
    assert counts[0] == counts[1] and counts[0] >= 4


def test_uncertain_confirmation_is_retryable_without_mutating_original_revision(world):
    client, remote, app = world
    sid = session(client)
    cid = chat(client, sid)["assistant_message"]["candidates"][0]["id"]
    remote.error_path = "/ingest"
    confirm_route = f"/api/sessions/{sid}/memories/confirm"
    edit_route = f"/api/sessions/{sid}/candidates/{cid}"
    assert client.post(confirm_route, json={"candidate_id": cid}).status_code == 502
    assert client.patch(edit_route, json={"content": "用户改为喜欢红茶"}).status_code == 409
    assert client.patch(edit_route, json={"status": "rejected"}).status_code == 409
    original_source = [r for r in remote.calls if r[1] == "/ingest"][-1][2]["source_id"]
    remote.error_path = None
    assert data(client.post(confirm_route, json={"candidate_id": cid}))["status"] == "confirmed"
    assert [r for r in remote.calls if r[1] == "/ingest"][-1][2]["source_id"] == original_source


def test_explicitly_empty_ingestion_can_edit_to_new_revision(world):
    client, remote, app = world
    sid = session(client)
    cid = chat(client, sid)["assistant_message"]["candidates"][0]["id"]
    route = f"/api/sessions/{sid}/memories/confirm"
    remote.skip = True
    assert client.post(route, json={"candidate_id": cid}).status_code == 422
    original_source = [r for r in remote.calls if r[1] == "/ingest"][-1][2]["source_id"]
    data(client.patch(f"/api/sessions/{sid}/candidates/{cid}", json={"content": "用户喜欢乌龙茶"}))
    remote.skip = False
    assert data(client.post(route, json={"candidate_id": cid}))["status"] == "confirmed"
    assert [r for r in remote.calls if r[1] == "/ingest"][-1][2]["source_id"] != original_source


def test_unknown_optional_model_values_keep_real_reply_and_deny_forbidden_actions(world):
    client, remote, app = world
    remote.reply = {"reply": "那我就静静坐在这里陪你。", "emotion": "calm", "actions": ["idle", "wave", "blink", "launch_shell"], "candidates": None, "reasoning": "可选模型元信息"}
    sid = session(client, "chat")
    result = chat(client, sid, "不要挥手，也不要眨眼，只安静陪着我。", "deny")["assistant_message"]
    assert result["content"] == remote.reply["reply"] and result["emotion"] == "neutral"
    assert result["actions"] == [] and result["candidates"] == []
    assert "reasoning" not in result


def test_optional_metadata_types_are_filtered_without_inventing_text():
    normalized = ModelOutput.from_model({"reply": "真实模型正文", "emotion": {}, "actions": ["blink", {"name": "wave"}, "unknown"], "candidates": ["用户喜欢茶", 5, " ", "x" * 2001]})
    assert normalized.reply == "真实模型正文"
    assert normalized.emotion == "neutral" and normalized.actions == ["blink"]
    assert normalized.candidates == ["用户喜欢茶"]
    for invalid in [{"emotion": "happy"}, {"reply": " "}, ["不是对象"], {"reply": 123}]:
        with pytest.raises(ValueError):
            ModelOutput.from_model(invalid)


@pytest.mark.parametrize("content,finish", [(None, "stop"), ([], "stop"), ("{}", "length"), (" " * 27, "stop")])
def test_missing_or_truncated_model_body_remains_an_error(world, content, finish):
    client, remote, app = world
    sid = session(client)
    original = remote.handle
    app.state.providers.client._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": finish}]}) if req.url.path.endswith("/chat/completions") else original(req))
    failed = client.post(f"/api/sessions/{sid}/chat", json={"content": "你好", "request_id": "invalid-body"})
    assert failed.status_code == 502
    assert data(client.get(f"/api/sessions/{sid}/messages"))["total"] == 0


def test_cancelled_confirmation_keeps_original_revision_retryable(world):
    from pet.schemas import CandidateBody
    client, remote, app = world
    config, store = account_connection(app, client), app.state.store
    sid = session(client)
    cid = chat(client, sid)["assistant_message"]["candidates"][0]["id"]

    async def scenario():
        started, finish = asyncio.Event(), asyncio.Event()

        class SlowIngestion:
            async def ingest(self, c, candidate):
                started.set()
                await finish.wait()
                return ["684ef0d3-1500-47a7-9996-fb96357e26f2"]

        service = PetService(store, SlowIngestion())
        task = asyncio.create_task(service.confirm(config, sid, cid))
        await asyncio.wait_for(started.wait(), 1)
        assert store.candidate(sid, config.scope, cid)["status"] == "pending"
        with store.db() as db:
            db.execute("UPDATE sessions SET title=%s WHERE id=%s", ("确认期间无长事务", sid))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert store.confirmation_state(cid) == "failed"
        with pytest.raises(ServiceError):
            await service.edit_candidate(config, sid, cid, CandidateBody(status="rejected"))
        finish.set()
        assert (await service.confirm(config, sid, cid))["status"] == "confirmed"

    asyncio.run(scenario())


def test_unsupported_dance_and_spin_are_not_claimed_as_smile():
    assert commands("请跳舞，再转圈") == ([], set())
    assert commands("请笑一笑")[0] == ["happy"]


@pytest.mark.parametrize("provider,changed_url", [("memoryos", "http://new-memory-host"), ("memoryos", "http://memory:8080")])
def test_changed_origin_cannot_send_inherited_secret(world, provider, changed_url):
    client, remote, app = world
    body = {provider: {"base_url": changed_url, "api_key": " "}}
    calls_before = len(remote.calls)
    result = client.post("/api/connection", json=body)
    assert result.status_code == 422
    assert len(remote.calls) == calls_before
    assert app.state.connection.memory_key == "memory-secret" and app.state.connection.llm_key == "llm-secret"
    assert "secret" not in result.text


def test_same_origin_path_change_keeps_key_and_explicit_new_key_is_allowed():
    from pet.schemas import ConnectBody
    config = Connection("http://memory", "memory-secret", USER, "https://model/v1", "llm-secret", "model")
    body = ConnectBody(memoryos={"base_url": "http://memory:80/v2", "user_id": USER})
    changed = config.update(body)
    assert changed.memory_key == "memory-secret" and changed.llm_key == "llm-secret"
    assert (changed.llm_url, changed.llm_key, changed.model) == (config.llm_url, config.llm_key, config.model)
    body.memoryos.base_url = "http://new-memory"
    body.memoryos.api_key = "new-key"
    assert config.update(body).memory_key == "new-key"


def test_oversized_keys_are_rejected_without_echo_or_provider_call(world):
    client, remote, app = world
    body = {"memoryos": {"api_key": "sensitive-marker-" * 300}}
    assert len(body["memoryos"]["api_key"]) > 4096
    before = len(remote.calls)
    failed = client.post("/api/connection", json=body)
    assert failed.status_code == 422 and "sensitive-marker" not in failed.text
    assert len(remote.calls) == before


@pytest.mark.parametrize("field,value", [
    ("llm", {"base_url": "https://untrusted-model/v1", "api_key": "sensitive-marker", "model": "other"}),
    ("llm_url", "https://untrusted-model/v1"),
    ("llm_key", "sensitive-marker"),
    ("model", "other"),
])
def test_browser_cannot_override_server_model(world, field, value):
    client, remote, app = world
    original = app.state.connection
    before = len(remote.calls)
    body = {**connect_body(), field: value}
    failed = client.post("/api/connection", json=body)
    assert failed.status_code == 422 and "sensitive-marker" not in failed.text
    assert app.state.connection == original and len(remote.calls) == before
    assert data(client.get("/api/status"))["llm"] == {"configured": True}


@pytest.mark.parametrize("missing", ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", None])
def test_model_environment_and_missing_configuration(world, monkeypatch, missing):
    client, remote, app = world
    values = {"MEMORYOS_BASE_URL": "http://memory", "MEMORYOS_API_KEY": "memory-secret", "MEMORYOS_USER_ID": USER,
              "LLM_BASE_URL": "https://server-model/v1", "LLM_API_KEY": "server-secret", "LLM_MODEL": "server-model"}
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    if missing:
        monkeypatch.delenv(missing)
    app.state.connection = Connection.environment()
    before = len(remote.calls)
    result = client.post("/api/connection", json=connect_body())
    if missing:
        assert result.status_code == 428 and "联系管理员" in result.json()["message"]
        assert data(client.get("/api/status"))["llm"] == {"configured": False}
        assert len(remote.calls) == before
    else:
        assert data(result)["llm"] == {"configured": True}
        assert not [c for c in remote.calls if c[1].endswith("/chat/completions")]
        sid = session(client)
        chat(client, sid)
        call = next(c for c in remote.calls if c[1] == "/v1/chat/completions")
        assert call[2]["model"] == "server-model" and call[4]["authorization"] == "Bearer server-secret"
        assert "server-secret" not in result.text and "server-model" not in result.text


def test_current_user_message_reminds_json_without_changing_memory_query_or_user_text(world):
    client, remote, app = world
    sid = session(client, "chat")
    content = "不要挥手，也不要眨眼，只安静陪着我。"
    result = chat(client, sid, content, "json-hint")
    request = [c for c in remote.calls if c[1].endswith("/chat/completions")][-1][2]
    latest = request["messages"][-1]["content"]
    assert latest.startswith("请依据以下用户消息生成完整 json 对象")
    assert all(field in latest for field in ["reply", "emotion", "actions", "candidates"])
    assert latest.endswith(content)
    assert request["response_format"] == {"type": "json_object"}
    assert [c for c in remote.calls if c[1] == "/recall"][-1][2]["query"] == content
    assert result["user_message"]["content"] == content
    assert result["assistant_message"]["actions"] == []


def test_public_docs_do_not_receive_private_api_cache_policy_and_unexpected_errors_are_sanitized(world, monkeypatch):
    client, _, app = world
    docs = client.get('/docs')
    assert docs.status_code == 200 and 'cache-control' not in docs.headers
    def broken(*args): raise RuntimeError('private-marker internal error')
    monkeypatch.setattr(app.state.store, 'sessions', broken)
    result = client.get('/api/sessions')
    assert result.status_code == 500 and result.json()['message'] == '服务处理失败，请稍后重试'
    assert 'private-marker' not in result.text


@pytest.mark.parametrize('path', ['/api/auth/login', '/api/auth/register'])
@pytest.mark.parametrize('content_type', [None, '', 'text/plain', 'application/x-www-form-urlencoded'])
def test_login_requires_json_content_type_even_when_body_is_valid_json(world, path, content_type):
    client, _, _ = world
    headers = {} if content_type is None else {'Content-Type':content_type}
    result = client.post(path, content=json.dumps({'username':'tester','password':'Test-password-123'}), headers=headers)
    assert result.status_code == 415
    assert result.json()['code'] == 415
    assert 'set-cookie' not in result.headers


def test_disconnect_wrapper_cancels_upstream_before_returning_on_outer_cancellation():
    from pet.main import disconnect_aware
    from unittest.mock import AsyncMock
    async def scenario():
        started, finished = asyncio.Event(), asyncio.Event()
        async def work():
            started.set()
            try: await asyncio.Future()
            finally: finished.set()
        task=asyncio.create_task(disconnect_aware(type('Request',(),{'is_disconnected':AsyncMock(return_value=False)})(),work()))
        await started.wait(); task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert finished.is_set()
    asyncio.run(scenario())
