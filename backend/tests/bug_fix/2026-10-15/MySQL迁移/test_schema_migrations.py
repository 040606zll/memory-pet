"""迁移不连接真实数据库，检查方言选择、全量基线及旧结构保护。"""
import importlib.util
from pathlib import Path
import re
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[4]
VERSIONS = BACKEND / "app" / "alembic" / "versions"


def migration(name):
    spec = importlib.util.spec_from_file_location(name, VERSIONS / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def operation(monkeypatch, dialect="mysql"):
    from alembic import op
    statements = []
    monkeypatch.setattr(op, "get_bind", lambda: SimpleNamespace(dialect=SimpleNamespace(name=dialect)))
    monkeypatch.setattr(op, "execute", statements.append)
    return statements


@pytest.mark.parametrize("dialect", ["mysql", "sqlite", "postgresql"])
def test_first_revision_selects_correct_dialect(monkeypatch, dialect):
    statements = operation(monkeypatch, dialect)
    migration("20261014_001_local_sessions.py").upgrade()
    combined = "\n".join(statements)
    assert "CREATE TABLE IF NOT EXISTS sessions" in combined
    assert ("ENGINE=InnoDB" in combined) == (dialect == "mysql")


def test_unknown_dialect_does_not_execute(monkeypatch):
    statements = operation(monkeypatch, "unknown")
    with pytest.raises(RuntimeError, match="不支持"):
        migration("20261014_001_local_sessions.py").upgrade()
    assert not statements


def test_mysql_baseline_is_complete_and_matches_component_sql():
    directory = BACKEND / "sql" / "mysql"
    baseline = (directory / "005_mysql_store.sql").read_text()
    tables = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)\s*\((.*?)\) ENGINE=InnoDB", baseline, re.S)
    assert {name for name, _ in tables} == {
        "sessions", "messages", "candidates", "operations", "memory_user_bindings",
        "local_accounts", "login_sessions", "account_memory_bindings", "login_attempts",
    }
    for _, definition in tables:
        assert "PRIMARY KEY" in definition
        assert "FOREIGN KEY" not in definition
        assert "REFERENCES" not in definition
    assert baseline.count("DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin") == 9
    for name in ("001_local_sessions.sql", "003_memory_user_bindings.sql", "004_accounts.sql"):
        assert (directory / name).read_text() in baseline
    assert "service_hash BINARY(32) NOT NULL" in baseline
    assert "GENERATED ALWAYS" not in baseline


def fake_inspector(tables=(), *, primary=None, computed=False, url_length=2048):
    return SimpleNamespace(
        get_table_names=lambda: list(tables),
        get_columns=lambda _: [
            {"name": "service_hash", **({"computed": {"sqltext": "sha2(service_url,256)"}} if computed else {})},
            {"name": "service_url", "type": SimpleNamespace(length=url_length)},
        ],
        get_pk_constraint=lambda name: {"constrained_columns": primary if primary is not None else {
            "account_memory_bindings": ["account_id", "service_hash"],
            "memory_user_bindings": ["service_hash", "api_key_id"],
        }[name]},
    )


@pytest.mark.parametrize("tables", [(), ("account_memory_bindings", "memory_user_bindings")])
def test_mysql_revision_applies_shared_baseline(monkeypatch, tables):
    import sqlalchemy
    statements = operation(monkeypatch)
    monkeypatch.setattr(sqlalchemy, "inspect", lambda _: fake_inspector(tables))
    migration("20261015_005_mysql_store.py").upgrade()
    assert len(statements) == 9
    assert all("CREATE TABLE IF NOT EXISTS" in item for item in statements)
    assert not any("ALTER TABLE" in item or "DROP TABLE" in item for item in statements)


@pytest.mark.parametrize("options", [
    {"primary": ["account_id", "service_url"]},
    {"computed": True},
    {"url_length": 512},
])
def test_mysql_revision_rejects_old_schema_without_mutation(monkeypatch, options):
    import sqlalchemy
    statements = operation(monkeypatch)
    monkeypatch.setattr(sqlalchemy, "inspect", lambda _: fake_inspector(("account_memory_bindings",), **options))
    with pytest.raises(RuntimeError, match="全新空库"):
        migration("20261015_005_mysql_store.py").upgrade()
    assert not statements


@pytest.mark.parametrize("dialect", ["sqlite", "postgresql"])
def test_mysql_revision_does_not_convert_other_databases(monkeypatch, dialect):
    statements = operation(monkeypatch, dialect)
    migration("20261015_005_mysql_store.py").upgrade()
    assert not statements


def test_mysql_revision_refuses_destructive_downgrade():
    with pytest.raises(RuntimeError, match="备份"):
        migration("20261015_005_mysql_store.py").downgrade()
