# 公网来源 403 修复：访问策略

所有现有 `/api/*` 路由和业务参数不变。新 AccessMiddleware 使用 AccessPolicy 校验请求 Host、Origin、Sec-Fetch-Site；没有新增登录接口或跨域 CORS。

## 配置

配置加载器新增字符串分组：

```toml
[server]
allowed_hosts = "81.71.39.10,pet.example.com"
allowed_origins = "http://81.71.39.10,https://pet.example.com"
```

两项默认空字符串，表示只保留本机入口。示例文件为 backend/config.server.example.toml，它不自动加载，需合并到现有 config.local.toml。环境变量 PET_ALLOWED_HOSTS、PET_ALLOWED_ORIGINS 与既有优先级一致：环境 > 本机文件 > 默认文件。

## 匹配规则

- Host 按完整 IP 或域名匹配，不匹配子串、后缀或通配符，忽略请求中的端口；域名大小写归一化。
- Origin 按协议、规范化主机和有效端口精确匹配，HTTP 80 与 HTTPS 443 视为各自默认端口，非默认端口严格区分。
- 兼容原有本机来源：127.0.0.1、localhost、::1、testserver；本机 HTTP／HTTPS 允许开发端口。
- 没有 Origin 的 CLI 请求仍按 Host 校验；来源白名单不是身份鉴权。
- 拒绝重复 Host／Origin、无效地址，以及所有明确的 Sec-Fetch-Site: cross-site 请求，即使来源已在白名单中。
- 不使用 X-Forwarded-Host 等头部作为放行依据，不要求代理清除 Origin。
- 配置格式无效时启动失败并返回中文说明，不回显配置值。

## 响应

不允许的请求返回 HTTP 403，格式沿用项目已有响应封装：

```json
{"code":403,"message":"访问地址未获允许，请检查后端 server.allowed_hosts 配置","data":null}
```

无公网配置时保留原提示“此服务仅允许本机访问”；Origin 拒绝提示检查 server.allowed_origins，跨站拒绝提示“不允许跨站请求”。不返回请求头或部署白名单内容。

公网采用 Nginx HTTPS + server 级 Basic 鉴权，授权账号仍共享一个应用，不构成多租户隔离。匿名入口必须返回 401。后端继续监听回环，不公开 8797。具体步骤和边界见《服务器更新步骤.md》。
