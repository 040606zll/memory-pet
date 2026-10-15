"""为宠物项目添加稳定用户绑定，不保存密钥或修改 MemoryOS 数据库。"""
from pathlib import Path

revision = "20261015_003"
down_revision = "20261014_002"
branch_labels = None
depends_on = None


def upgrade():
    from alembic import op
    dialect = op.get_bind().dialect.name
    if dialect not in {"sqlite", "mysql", "postgresql"}:
        raise RuntimeError("此数据库暂不支持用户绑定迁移")
    sql = Path(__file__).resolve().parents[3] / "sql" / dialect / "003_memory_user_bindings.sql"
    op.execute(sql.read_text())


def downgrade():
    raise RuntimeError("删除用户绑定会影响记忆归属，请先备份并取得明确授权")
