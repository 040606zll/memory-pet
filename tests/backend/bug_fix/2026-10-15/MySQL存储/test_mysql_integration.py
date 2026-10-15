"""真实 MySQL 回归：仅允许显式指定的专用测试库，无凭据时明确跳过。"""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import threading

import httpx
import pytest

from test_api import world, data, session, chat
from pet.accounts import Accounts
from pet.errors import ServiceError


ROOT = next(path for path in Path(__file__).resolve().parents if (path / "backend/start.sh").is_file())


def test_mysql_transaction_commit_rollback_and_pool_release(mysql_store):
    store = mysql_store
    baseline = store.engine.pool.checkedout()
    with store.db() as db:
        db.execute("INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(%s,%s,%s)", ("committed", 1, 123))
    with pytest.raises(RuntimeError, match="主动回滚"):
        with store.db() as db:
            db.execute("INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(%s,%s,%s)", ("rolled-back", 1, 123))
            raise RuntimeError("主动回滚")
    with store.db() as db:
        assert db.execute("SELECT bucket FROM login_attempts ORDER BY bucket").fetchall() == [{"bucket": "committed"}]
    assert store.engine.pool.checkedout() == baseline


def test_mysql_unique_key_failure_rolls_back_and_returns_connection(mysql_store):
    from sqlalchemy.exc import IntegrityError
    baseline = mysql_store.engine.pool.checkedout()
    with mysql_store.db() as db:
        db.execute("INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(%s,%s,%s)", ("duplicate", 1, 123))
    with pytest.raises(IntegrityError):
        with mysql_store.db() as db:
            db.execute("INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(%s,%s,%s)", ("rolled-back-too", 1, 123))
            db.execute("INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES(%s,%s,%s)", ("duplicate", 2, 123))
    with mysql_store.db() as db:
        assert db.execute("SELECT bucket FROM login_attempts").fetchall() == [{"bucket": "duplicate"}]
    assert mysql_store.engine.pool.checkedout() == baseline


def test_mysql_utf8mb4_messages_and_independent_scope(mysql_store):
    created = mysql_store.create_session("owner", "training", "中文 🐼 𠮷", "memory")
    assert mysql_store.session(created["id"], "owner")["title"] == "中文 🐼 𠮷"
    with pytest.raises(ServiceError) as raised:
        mysql_store.session(created["id"], "other-owner")
    assert raised.value.status == 404


def test_mysql_parallel_account_provision_claim_has_single_owner(mysql_store):
    accounts = Accounts(mysql_store)
    account = accounts.create("concurrent_test", "test-hash")
    gate = threading.Barrier(2)

    def claim():
        gate.wait(timeout=3)
        try:
            return accounts.claim(account["id"], "http://memory")
        except ServiceError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: claim(), range(2)))
    assert len([result for result in results if isinstance(result, str)]) == 1
    assert results.count(409) == 1
    assert mysql_store.engine.pool.checkedout() == 0


def test_mysql_alembic_baseline_is_repeatable_and_keeps_existing_sessions(mysql_store):
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    created = mysql_store.create_session("owner", "training", "迁移前的数据")
    revision = ROOT / "backend/app/alembic/versions/20261015_005_mysql_store.py"
    spec = importlib.util.spec_from_file_location("mysql_store_revision_test", revision)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with mysql_store.engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.upgrade()
    assert mysql_store.session(created["id"], "owner")["title"] == "迁移前的数据"


def test_mysql_connections_are_released_during_memory_and_model_network_calls(world):
    client, remote, app = world
    checked = []
    original = remote.handle

    def handle(request):
        # 真实连接池占用来自运行时 Store，不使用假连接计数器。
        checked.append((request.url.path, app.state.store.engine.pool.checkedout()))
        return original(request)

    app.state.providers.client._transport = httpx.MockTransport(handle)
    training = session(client)
    candidate = chat(client, training)["assistant_message"]["candidates"][0]["id"]
    data(client.post(f"/api/sessions/{training}/memories/confirm", json={"candidate_id": candidate}))
    chat(client, session(client, "chat"), "你记得我喜欢什么吗？", "pool-recall")
    paths = {path for path, _ in checked}
    assert "/recall" in paths and "/ingest" in paths and "/chat/completions" in paths
    assert all(occupied == 0 for _, occupied in checked)
