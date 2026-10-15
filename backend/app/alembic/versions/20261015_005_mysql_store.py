"""补齐新 MySQL 全量基线，拒绝静默复用不兼容的历史绑定表。"""
from pathlib import Path

revision = "20261015_005"
down_revision = "20261015_004"
branch_labels = None
depends_on = None


def upgrade():
    from alembic import op
    from sqlalchemy import inspect

    bind = op.get_bind()
    # 历史 SQLite/PostgreSQL 迁移链仍可读取，但不把这些库转换为 MySQL。
    if bind.dialect.name != "mysql":
        return
    inspector = inspect(bind)
    existing = set(inspector.get_table_names())
    expected_keys = {
        "memory_user_bindings": ["service_hash", "api_key_id"],
        "account_memory_bindings": ["account_id", "service_hash"],
    }
    for table, expected in expected_keys.items():
        if table not in existing:
            continue
        columns = {column["name"]: column for column in inspector.get_columns(table)}
        primary = inspector.get_pk_constraint(table).get("constrained_columns", [])
        # 用户选择全新库，不擅自对旧绑定数据转换主键或重新计算摘要。
        if (primary != expected or "service_hash" not in columns
                or columns["service_hash"].get("computed")
                or getattr(columns.get("service_url", {}).get("type"), "length", 0) != 2048):
            raise RuntimeError("检测到不兼容的历史 MySQL 绑定表，请为宠物应用配置全新空库；此迁移不会转换或删除旧数据")
    path = Path(__file__).resolve().parents[3] / "sql" / "mysql" / "005_mysql_store.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("MySQL 存储包含账号和对话数据，回退前必须先备份并取得明确授权")
