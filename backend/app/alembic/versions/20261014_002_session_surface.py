"""为独立对话库增加surface，旧会话默认pet；不操作MemoryOS数据库。"""
from pathlib import Path

revision = "20261014_002"
down_revision = "20261014_001"
branch_labels = None
depends_on = None


def upgrade():
    from alembic import op
    from sqlalchemy import inspect
    bind = op.get_bind()
    if "surface" in {column["name"] for column in inspect(bind).get_columns("sessions")}:
        return
    dialect = {"sqlite": "sqlite", "mysql": "mysql", "postgresql": "postgresql"}.get(bind.dialect.name)
    if dialect is None:
        raise RuntimeError("不支持此数据库的surface迁移，请先提供对应迁移方案")
    sql = Path(__file__).resolve().parents[3] / "sql" / dialect / "002_session_surface.sql"
    op.execute(sql.read_text())


def downgrade():
    raise RuntimeError("回退会丢失两种页面的会话归属，请先备份并获得明确授权")
