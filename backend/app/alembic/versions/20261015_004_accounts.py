"""增加账号登录与一对一记忆用户映射，保留历史会话和旧绑定。"""
from pathlib import Path

revision = "20261015_004"
down_revision = "20261015_003"
branch_labels = None
depends_on = None


def upgrade():
    from alembic import op
    dialect = op.get_bind().dialect.name
    if dialect not in {"sqlite", "postgresql", "mysql"}:
        raise RuntimeError("此数据库暂不支持账号迁移")
    path = Path(__file__).resolve().parents[3] / "sql" / dialect / "004_accounts.sql"
    # 每条DDL独立执行，兼容不允许一次执行多条语句的数据库驱动。
    for statement in path.read_text().split(';'):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("账号、登录和记忆绑定包含用户数据，回退前必须先备份并取得明确授权")
