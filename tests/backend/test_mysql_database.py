"""MySQL 配置、驱动边界及事务契约；替身用例不宣称完成真实数据库验证。"""
from contextlib import contextmanager
from unittest.mock import Mock

import pytest
from sqlalchemy.exc import IntegrityError, OperationalError

from mysql_fixtures import validated_test_url
from pet.database import DatabaseConfig, DatabaseSession, MySQLDatabase, QueryResult
from pet.errors import ServiceError
from pet.store import Store


@pytest.mark.parametrize('identifier', ['不存在', 'x' * 65])
def test_unknown_non_ascii_and_oversized_ids_are_not_database_failures(mysql_store, identifier):
    session = mysql_store.create_session('owner', 'training', '编号边界')
    with pytest.raises(ServiceError) as missing_session:
        mysql_store.session(identifier, 'owner')
    assert missing_session.value.status == 404
    with pytest.raises(ServiceError) as missing_candidate:
        mysql_store.candidate(session['id'], 'owner', identifier)
    assert missing_candidate.value.status == 404
    # 无效输入不会破坏后续事务或越过归属检查。
    assert mysql_store.session(session['id'], 'owner')['title'] == '编号边界'
    with pytest.raises(ServiceError) as wrong_owner:
        mysql_store.candidate(session['id'], 'someone-else', identifier)
    assert wrong_owner.value.status == 404


@pytest.mark.parametrize("port", [3306, "3307"])
def test_mysql_configuration_accepts_file_and_environment_port_types(port):
    config = DatabaseConfig.from_settings({"PET_MYSQL_HOST": "db.example.test", "PET_MYSQL_PORT": port, "PET_MYSQL_DATABASE": "pet_test", "PET_MYSQL_USER": "pet", "PET_MYSQL_PASSWORD": "secret:@/密码"})
    assert config.port == int(port)
    assert config.url.drivername == "mysql+pymysql"
    assert config.url.password == "secret:@/密码" and config.url.query["charset"] == "utf8mb4"
    assert "secret" not in repr(config) and "secret" not in str(config.url)


@pytest.mark.parametrize("port", [0, 65536, "invalid", None])
def test_mysql_configuration_rejects_invalid_port_without_echoing_credentials(port):
    with pytest.raises(ServiceError) as error:
        DatabaseConfig.from_settings({"PET_MYSQL_PORT": port, "PET_MYSQL_PASSWORD": "private-marker"})
    assert "MySQL" in str(error.value) and "private-marker" not in str(error.value)


@pytest.mark.parametrize("field,value", [("host", ""), ("user", ""), ("database", ""), ("database", "pet/db"), ("database", "a" * 65)])
def test_mysql_configuration_rejects_unsafe_or_missing_components(field, value):
    with pytest.raises(ServiceError):
        DatabaseConfig(**{field: value})


@pytest.mark.parametrize("dsn", ["sqlite:///pet.sqlite3", "postgresql://test:password@host/test", "invalid", "mysql://test:private-marker@host/"])
def test_mysql_connection_rejects_other_backends_and_invalid_urls(dsn):
    with pytest.raises(ServiceError) as error:
        DatabaseConfig.from_url(dsn)
    assert "private-marker" not in str(error.value)


def test_mysql_url_preserves_encoded_password_without_exposing_it():
    config = DatabaseConfig.from_url("mysql+pymysql://pet:secret%40%3Apass@localhost:3307/pet_test")
    assert config.password == "secret@:pass" and config.port == 3307
    assert "secret" not in repr(config)


@pytest.mark.parametrize("dsn", ["sqlite:///pet_test", "mysql://pet:private-marker@host/production", "mysql://pet:private-marker@host/latest_production", "mysql://pet@host/", "invalid"])
def test_database_fixture_refuses_destructive_cleanup_outside_test_database(dsn):
    with pytest.raises(ValueError) as error:
        validated_test_url(dsn)
    assert "private-marker" not in str(error.value)


def test_database_fixture_accepts_only_explicit_mysql_test_database():
    url = validated_test_url("mysql://pet:private-marker@127.0.0.1/memory_pet_test")
    assert url.drivername == "mysql+pymysql" and url.database == "memory_pet_test"


def test_mysql_pool_creation_is_lazy_and_hides_query_parameters(monkeypatch):
    from pet import database
    engine = Mock()
    create = Mock(return_value=engine)
    monkeypatch.setattr(database, "create_engine", create)
    store = Store(DatabaseConfig(database="pet_test"))
    engine.begin.assert_not_called()
    assert create.call_args.kwargs["hide_parameters"] is True
    assert create.call_args.kwargs["isolation_level"] == "READ COMMITTED"
    assert create.call_args.kwargs["pool_pre_ping"] is True
    store.close()
    engine.dispose.assert_called_once()


def test_query_result_materializes_dictionary_rows():
    result = Mock(rowcount=2)
    result.mappings.return_value.fetchone.side_effect = [{"id": "first"}, None]
    result.mappings.return_value.fetchall.return_value = [{"id": "first"}, {"id": "second"}]
    query = QueryResult(result)
    assert query.rowcount == 2 and query.fetchone() == {"id": "first"}
    assert query.fetchone() is None
    assert query.fetchall() == [{"id": "first"}, {"id": "second"}]


def test_session_forwards_parameterized_mysql_sql_and_batches_without_interpolation():
    connection = Mock()
    session = DatabaseSession(connection)
    session.execute("SELECT id FROM sessions WHERE title=%s", ["quote ' % 私密"])
    connection.exec_driver_sql.assert_called_once_with("SELECT id FROM sessions WHERE title=%s", ("quote ' % 私密",))
    session.executemany("INSERT INTO candidates(id) VALUES(%s)", [["first"], ["second"]])
    assert connection.exec_driver_sql.call_args.args == ("INSERT INTO candidates(id) VALUES(%s)", [("first",), ("second",)])
    connection.reset_mock()
    assert session.executemany("INSERT INTO candidates(id) VALUES(%s)", []) is None
    connection.exec_driver_sql.assert_not_called()


@pytest.mark.parametrize("error", [None, RuntimeError("业务失败"), OperationalError("secret statement", {}, Exception("private-marker")), IntegrityError("duplicate", {}, Exception("private-marker"))])
def test_transaction_exits_on_success_failure_and_sanitizes_driver_errors(monkeypatch, error):
    from pet import database
    exits = []
    connection = Mock()

    @contextmanager
    def begin():
        try:
            yield connection
        finally:
            exits.append(True)

    engine = Mock()
    engine.begin = begin
    monkeypatch.setattr(database, "create_engine", Mock(return_value=engine))
    db = MySQLDatabase(DatabaseConfig(database="pet_test"))
    if error is None:
        with db.db() as session:
            assert session.connection is connection
    else:
        expected = ServiceError if isinstance(error, OperationalError) else type(error)
        with pytest.raises(expected) as raised:
            with db.db():
                raise error
        if isinstance(error, OperationalError):
            assert raised.value.status == 503
            assert "private-marker" not in str(raised.value)
    assert exits == [True]


def test_schema_initialization_uses_mysql_baseline_and_recovers_interrupted_operations(monkeypatch):
    from pet import database
    connection = Mock()
    engine = Mock()
    engine.begin.return_value.__enter__ = Mock(return_value=connection)
    engine.begin.return_value.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(database, "create_engine", Mock(return_value=engine))
    store = Store(DatabaseConfig(database="pet_test"))
    store.initialize()
    statements = [call.args[0] for call in connection.exec_driver_sql.call_args_list]
    assert any("CREATE TABLE IF NOT EXISTS local_accounts" in sql for sql in statements)
    assert any("ENGINE=InnoDB" in sql for sql in statements)
    assert "UPDATE operations SET state='failed' WHERE state='running'" in statements
    assert not any("PRAGMA" in sql or "sqlite" in "\n".join(line for line in sql.splitlines() if not line.strip().startswith("--")).lower() for sql in statements)


def test_run_db_uses_worker_thread_and_forwards_result():
    import asyncio
    import threading
    from pet.database import run_db

    async def scenario():
        loop_thread = threading.get_ident()

        def query(value, *, increment):
            assert threading.get_ident() != loop_thread
            return value + increment

        assert await run_db(query, 3, increment=4) == 7

    asyncio.run(scenario())


def test_run_db_cancellation_waits_for_transaction_completion_before_cleanup():
    import asyncio
    import threading
    from pet.database import run_db
    started, release = threading.Event(), threading.Event()
    order = []

    def transaction():
        started.set()
        assert release.wait(timeout=3), "测试未释放事务线程"
        order.append("transaction-finished")

    async def scenario():
        async def request():
            try:
                await run_db(transaction)
            finally:
                order.append("request-cleanup")

        task = asyncio.create_task(request())
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and order == []
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert order == ["transaction-finished", "request-cleanup"]

    try:
        asyncio.run(scenario())
    finally:
        release.set()


@pytest.mark.parametrize("outcome", [None, {"assistant_message": {"content": "已完成"}}, ServiceError("已有请求运行中", 409)])
def test_cancelled_begin_operation_only_cleans_the_operation_it_acquired(outcome):
    import asyncio
    import threading
    from pet.service import PetService
    started, release = threading.Event(), threading.Event()
    store = Mock()

    def begin(*args, **kwargs):
        started.set()
        assert release.wait(timeout=3)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    store.begin_operation.side_effect = begin
    service = PetService(store, None)

    async def scenario():
        task = asyncio.create_task(service.begin_operation("request-key", "session-id", "fingerprint"))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        if outcome is None:
            store.fail_operation.assert_called_once_with("request-key")
        else:
            store.fail_operation.assert_not_called()

    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_cancelled_account_claim_waits_for_commit_and_releases_exact_lease_owner():
    import asyncio
    import threading
    from unittest.mock import AsyncMock
    from pet.config import Connection
    from pet.connections import AccountConnections
    started, release = threading.Event(), threading.Event()
    claimed = []
    order = []
    accounts = Mock()
    accounts.binding.return_value = None

    def claim(account_id, url, owner):
        claimed.append((account_id, url, owner))
        started.set()
        assert release.wait(timeout=3)
        order.append("claim-committed")
        return owner

    accounts.claim.side_effect = claim
    accounts.release.side_effect = lambda *args: order.append("lease-released")
    providers = Mock()
    providers.memory = AsyncMock(return_value={"status": "ready"})
    resolver = AccountConnections(accounts, providers)
    config = Connection(memory_url="http://memory", memory_key="private-service-key")

    async def scenario():
        task = asyncio.create_task(resolver.resolve(config, "account-id"))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and order == []
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(claimed) == 1 and claimed[0][2]
        accounts.release.assert_called_once_with(*claimed[0])
        accounts.bind.assert_not_called()
        assert providers.memory.await_count == 1
        assert order == ["claim-committed", "lease-released"]

    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_inflight_request_is_not_started_twice_and_empty_candidates_are_scoped(mysql_store):
    session = mysql_store.create_session('owner','chat','请求并发')
    assert mysql_store.begin_operation('once',session['id'],'f' * 64) is None
    with pytest.raises(ServiceError) as active:
        mysql_store.begin_operation('once',session['id'],'f' * 64)
    assert active.value.status == 409
    assert mysql_store.candidates_by_ids(session['id'],'owner',[]) == {}
    with pytest.raises(ServiceError) as unauthorized:
        mysql_store.candidates_by_ids(session['id'],'other',[])
    assert unauthorized.value.status == 404
    mysql_store.fail_operation('once')
    assert mysql_store.begin_operation('once',session['id'],'f' * 64) is None
