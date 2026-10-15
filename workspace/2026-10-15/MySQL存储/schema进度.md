# MySQL 建表与迁移子任务

已完成，新库使用 MySQL 8，不连接真实数据库、不导入或删除 SQLite 数据。

## 文件与结构

- `backend/sql/mysql/005_mysql_store.sql`：运行时和 Alembic 005 共用的完整幂等基线，共 9 张表：sessions、messages、candidates、operations、memory_user_bindings、local_accounts、login_sessions、account_memory_bindings、login_attempts。
- `backend/sql/mysql/001_local_sessions.sql`：补齐会话、消息、候选、幂等四表。
- `backend/sql/mysql/003_memory_user_bindings.sql`、`004_accounts.sql`：统一 utf8mb4_bin、标识符 ascii_bin；两类绑定均以普通 BINARY(32) service_hash 作为复合业务主键的一部分，URL 保留 2048 字符。写入端通过 UNHEX(SHA2(service_url,256)) 计算摘要。
- `backend/sql/postgresql/001_local_sessions.sql`：补齐历史 PostgreSQL 迁移链起点，不改变应用仅使用 MySQL 的运行时选择。
- `backend/app/alembic/versions/20261014_001_local_sessions.py`：按数据库方言选择起始 SQL。
- `backend/app/alembic/versions/20261015_005_mysql_store.py`：检查两类历史绑定表的主键、非生成摘要列及 URL 长度，发现旧结构则明确要求使用全新空库，不转换旧数据；兼容新库重复执行。
- `backend/alembic.ini`、`backend/app/alembic/env.py`：迁移入口复用应用的 DatabaseConfig.from_settings(load_settings()).url，不打印包含密码的连接地址。历史迁移需要在线检查结构，不支持缺乏检查的离线 SQL 模式。
- `backend/tests/bug_fix/2026-10-15/MySQL迁移/test_schema_migrations.py`：方言选择、全量表和主键、共享基线一致性、旧结构拒绝保护、非 MySQL 库不转换、禁止破坏性回退。

## 验证

- `/opt/anaconda3/envs/xyd/bin/python -B -m pytest backend/tests/bug_fix/2026-10-15/MySQL迁移/test_schema_migrations.py -q --disable-warnings`：13 条通过。
- `python -B -m alembic -c backend/alembic.ini history`：001 → 002 → 003 → 004 → 005 完整单头迁移链可加载。
- 已用本机已有 sqlglot 的 MySQL 方言解析完整基线：9 条 CREATE 均解析成功，未新增此测试依赖。
- 本子任务未执行真实 MySQL 建表、查询、迁移或联网验证；真实 MySQL 集成验证由主代理统一安排。

## 影响与限制

只新增/修正建表和迁移文件，没有修改运行时或实际配置。所有关联均为逻辑关联，不新增物理外键；正文支持中文与 emoji，业务标识符和令牌保持大小写敏感。用户已明确使用新库，发现旧 MySQL 绑定结构时停止并说明，禁止静默复用或自动转换旧数据。
