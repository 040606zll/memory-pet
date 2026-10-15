"""按目标数据库创建宠物应用会话结构，不涉及 MemoryOS 数据库。"""
from pathlib import Path

revision = "20261014_001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    from alembic import op
    dialect = op.get_bind().dialect.name
    if dialect not in {"sqlite", "mysql", "postgresql"}:
        raise RuntimeError("此数据库暂不支持会话迁移")
    sql = (Path(__file__).resolve().parents[3] / "sql" / dialect / "001_local_sessions.sql").read_text()
    for statement in sql.split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    # 按仓库规则不自动删除数据，需要由用户明确批准并另行编写回退方案。
    raise RuntimeError("回退会删除对话和幂等状态，请先备份并获得明确授权")
