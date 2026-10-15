"""隔离应用配置；数据库用例只允许显式配置的独立 MySQL 测试库。"""
import atexit
import os
import re
from pathlib import Path
import sys
import tempfile

import pytest

_TEST_RUNTIME = tempfile.TemporaryDirectory(prefix="memory-pet-tests-")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from pet import settings
settings.CONFIG_FILE = Path(_TEST_RUNTIME.name) / "config.toml"
settings.LOCAL_CONFIG_FILE = Path(_TEST_RUNTIME.name) / "config.local.toml"
# 导入默认应用不得连接开发者的真实数据库；MySQL 连接只在 lifespan 建立。
for name, value in {"HOST": "127.0.0.1", "PORT": "3306", "DATABASE": "memory_pet_test_import", "USER": "test_unconfigured", "PASSWORD": ""}.items():
    os.environ["PET_MYSQL_" + name] = value
atexit.register(_TEST_RUNTIME.cleanup)


def validated_test_url(raw):
    """先校验独立库名，再允许执行任何清理 SQL，不创建或操作业务数据库。"""
    from sqlalchemy.engine import make_url
    try:
        url = make_url(raw)
    except Exception:
        raise ValueError("PET_TEST_MYSQL_URL 格式无效") from None
    if url.get_backend_name() != "mysql" or not url.database or not re.search(r"(^|_)test(_|$)", url.database.lower()):
        raise ValueError("测试连接必须是 MySQL，且独立数据库名称必须含 test 独立字段，例如 memory_pet_test")
    return url.set(drivername="mysql+pymysql")


@pytest.fixture
def mysql_config():
    raw = os.environ.get("PET_TEST_MYSQL_URL")
    if not raw:
        pytest.skip("未配置 PET_TEST_MYSQL_URL，未执行真实 MySQL 数据库链路")
    from pet.database import DatabaseConfig
    from pet.store import Store
    from sqlalchemy import inspect
    try:
        url = validated_test_url(raw)
    except ValueError as error:
        pytest.fail(str(error), pytrace=False)
    config = DatabaseConfig.from_settings({
        "PET_MYSQL_HOST": url.host or "127.0.0.1", "PET_MYSQL_PORT": str(url.port or 3306),
        "PET_MYSQL_DATABASE": url.database, "PET_MYSQL_USER": url.username or "",
        "PET_MYSQL_PASSWORD": url.password or "",
    })
    store = Store(config)
    try:
        store.initialize()
    except Exception:
        store.engine.dispose()
        pytest.fail("已显式配置的 MySQL 测试库无法连接或初始化，请检查测试配置", pytrace=False)

    def clean():
        # 仅清理固定的本项目表；不遍历删除同库其他应用的数据。
        tables = {"candidates", "messages", "operations", "sessions", "account_memory_bindings", "login_sessions", "login_attempts", "local_accounts", "memory_user_bindings"}
        existing = set(inspect(store.engine).get_table_names())
        with store.engine.begin() as db:
            for table in ("candidates", "messages", "operations", "sessions", "account_memory_bindings", "login_sessions", "login_attempts", "local_accounts", "memory_user_bindings"):
                if table in existing and table in tables:
                    db.exec_driver_sql("DELETE FROM `" + table + "`")
    clean()
    try:
        yield config
    finally:
        clean()
        store.engine.dispose()


@pytest.fixture
def mysql_store(mysql_config):
    from pet.store import Store
    store = Store(mysql_config)
    store.initialize()
    yield store
    store.engine.dispose()
