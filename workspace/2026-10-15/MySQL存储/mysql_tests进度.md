# MySQL 测试迁移完成记录

修改了测试共享夹具与主业务测试，账号、聊天、记忆确认和隔离用例继续保留。SQLite 文件级断言改为数据库字段与摘要断言，直接 SQL 改为 MySQL `%s`、字典行、绑定地址摘要，查询次数改用 SQLAlchemy 事件。旧 SQLite 升级用例按用户选择全新 MySQL 库改为 MySQL 幂等初始化和约束测试；历史比较脚本只读 MySQL。

## 安全隔离

- `tests/backend/mysql_fixtures.py` 统一隔离真实配置与默认应用，`tests/backend/conftest.py` 与 `backend/tests/conftest.py` 共享注册，支持单独执行档案测试和混合集合。
- 真实数据库测试仅读取显式 `PET_TEST_MYSQL_URL`，校验 MySQL 和具有独立 `test` 字段的专用库名（例如 `memory_pet_test`）之后，才允许初始化和清理固定的九张项目表；不会创建业务数据库、连接实际 MemoryOS 数据库或读取产品凭据。
- 未提供测试 URL 时明确 skip；显式提供但连接失败会 fail，不假装通过。
- 来源策略用例只 mock 启动建表，未伪造 SQL 查询结果；纯 MySQL 模块单测使用驱动接口替身，报告中不计为真实 MySQL 链路验收。

## 新增验证

`tests/backend/test_mysql_database.py` 覆盖 MySQL 配置、密码特殊字符、敏感值不回显、SQLite/PostgreSQL URL 拒绝、测试库保护、参数绑定、空批次、事务退出、连接池懒加载、中文上游错误。异步边界验证工作线程、取消等待数据库线程完成、已取得请求清理；已完成/409 请求不得误清理。账号租约验证提交晚于取消时仍等待完成并精确释放原 owner。

`tests/backend/bug_fix/2026-10-15/MySQL存储/test_mysql_integration.py` 预备六条真实 MySQL 验证：提交与回滚、唯一冲突整批回滚和连接归还、utf8mb4、并发租约单一持有人、005迁移重复执行和数据保留、模型/MemoryOS网络阶段真实连接池占用归零。本机无授权测试凭据，均未执行。

## 最终结果

2026-10-15 本机 xyd Python 3.11 执行：

```bash
python -B -m pytest tests/backend \
  backend/tests/bug_fix/2026-10-15/本地记忆连接生产模式误拦截 \
  backend/tests/bug_fix/2026-10-15/MySQL迁移 \
  --ignore=tests/backend/test_start_script.py \
  --ignore=tests/backend/bug_fix/2026-10-15/服务停止与重启/test_service_commands.py \
  -q --disable-warnings --cov=pet.database --cov-report=term-missing \
  --junitxml=workspace/2026-10-15/MySQL存储/mysql_tests结果.xml
```

最终统一回归：178 passed，118 skipped，3.98秒。`pet.database` 80条语句，100%覆盖。该覆盖率仅表示新数据库边界的单元覆盖，不表示真实 MySQL 业务链路已验收。118个skip包括未提供MySQL测试凭据的业务/数据库链路以及既有平台用例。

两个启动脚本测试文件未修改，本轮排除：用户此前将启动脚本改为Linux Conda路径，原用例固定匹配本机xyd配置，属于已知无关差异。

## 后续真实数据库验收

用户配置专用 MySQL 测试库后，以环境变量传入 `PET_TEST_MYSQL_URL`（不要写入报告或日志），重新运行上述命令。夹具每条用例都会清理该专用库中的本项目表，因此绝对不能填业务库。主代理仍需向用户明确真实 MySQL 测试尚待配置，不能声称注册登录和记忆写入已在真实 MySQL 成功。
