"""Alembic 复用应用 MySQL 配置，不输出包含凭据的连接地址。"""
from alembic import context
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

from pet.database import DatabaseConfig
from pet.settings import load_settings


def run_migrations_online():
    configuration = DatabaseConfig.from_settings(load_settings())
    engine = create_engine(configuration.url, poolclass=NullPool, hide_parameters=True)
    try:
        with engine.connect() as connection:
            context.configure(connection=connection, target_metadata=None)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    # 历史迁移需要检查列和索引，避免生成缺乏结构校验的离线 SQL。
    raise RuntimeError("此迁移需要在线检查表结构，请配置新 MySQL 库后执行 upgrade head")
run_migrations_online()
