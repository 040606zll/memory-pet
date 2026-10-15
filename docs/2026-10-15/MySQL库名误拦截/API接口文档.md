# MySQL 库名误拦截修复说明

## 问题与影响

服务启动加载 `DatabaseConfig.from_settings()` 时，原有正则仅允许英文字母、数字和下划线。MySQL 实际允许的 `memory-pet`、中文库名因此在建立连接之前被拒绝，报“ MySQL 配置无效，请检查主机、用户名和数据库名称”。

本次只调整配置校验，不新增或修改 HTTP 接口、数据表及数据库迁移。账号登录、聊天和记忆接口的请求与响应保持原有约定。

## 配置行为

`[mysql]` 的 `database` 原样作为 SQLAlchemy `URL.create()` 的数据库参数，由驱动建立连接，不参与 SQL 字符串拼接。

- 允许横线、中文、保留字、纯数字和其他合法特殊字符，不替换或自动去掉字符。
- 长度为 1 至 64 个字符。
- 拒绝 NUL、非基本多文种平面字符、无效的代理码位、`/`、反斜线、`.` 和末尾空格。
- `host`、`user` 不能是空值或仅空白的字符串。
- 配置错误分别提示 `mysql.host`、`mysql.user`、`mysql.database`，不返回配置值或密码。

规则依据：[MySQL 8.0 标识符规则](https://dev.mysql.com/doc/refman/8.0/en/identifiers.html) 和 [标识符长度限制](https://dev.mysql.com/doc/refman/8.0/en/identifier-length.html)。数据库名中合法的特殊字符无需在 TOML 字符串内部额外添加 SQL 反引号。

## 部署验证

更新 `backend/pet/database.py` 后，保留服务器真实连接配置并重新启动服务。此次修复只解除本地配置误拦截；库不存在、权限不足或网络连接异常仍需要根据实际数据库错误排查。本次没有访问远程服务器、修改真实配置或重启服务。
