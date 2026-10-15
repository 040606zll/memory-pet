# 移除匿名用户目录前置检查

## 本次行为

用户明确要求删除连接时的匿名目录检查。原流程向 MemoryOS 发起不带凭据的 GET /users，若返回 200，则以 409 提示必须开启 AUTH_ENFORCED；本次删除该探测及其阻断逻辑。

修改 backend/pet/connections.py、backend/pet/providers.py，不改前端或 MemoryOS。本次同时影响宠物页与普通记忆页的 POST /api/connection，参数和响应结构不变。后端已配置 MemoryOS Key 且服务地址不变时，页面仍可留空 Key 复用配置并验证连接。

后续用户目录、详情、创建、记忆权限与模型验证继续执行。MemoryOS 请求仍携带 X-API-Key；有效 UUID、api_key_id、用户状态、本地一对一绑定及禁止换绑等原有校验保留。上游缺字段仍会返回语义化错误，删除预探测不保证任何兼容模式均能成功绑定。

## 服务器更新

更新包 remove-directory-probe.zip 只含：

```text
pet/connections.py
pet/providers.py
REMOVE_DIRECTORY_PROBE_DEPLOY.md
```

解压到含 run.py 的实际后端目录，当前服务器为：

```text
/root/www/server/memory-pet/backend/backend/
```

只替换这两个业务 Python 文件，包中不含配置、Key、数据库、Conda 脚本或其他访问策略，不会覆盖已有白名单。建议保留网站目录之外的原文件备份。

使用已更新的启动脚本时，在实际后端目录运行：

```bash
./start.sh restart
./start.sh status
```

若使用 systemd 则使用原服务管理器重启。前端不需要重新打包，MemoryOS 不需要为此次代码更新重启。随后从页面点击连接服务验收；不再出现匿名目录可读导致的 AUTH_ENFORCED 提示。

## 接口与部署边界

- POST /api/connection：删除匿名目录门槛，不增加参数，不暴露 Key。
- 上游 401/403：仍返回“记忆服务鉴权失败，请检查 API Key 和用户权限”。
- 用户信息缺失有效归属字段：仍返回 502，不写入绑定。
- 用户归属不一致或换绑冲突：仍拒绝，不替换当前连接。
- 正常连接：确认用户、验证模型和记忆权限后持久绑定，connected=true。

本次不修改 MemoryOS 的 AUTH_ENFORCED 或生产配置。取消预探测后，宠物端不再判断上游用户目录是否按 Key 隔离；全站目录中的归属字段不能证明其属于实际输入的 Key。本地唯一绑定仅约束上游返回的标识。MemoryOS 公网部署仍使用 production 配置，宠物仍为单受信任用户服务。

服务器本次尚未上传或重启，验收需使用目标服务器真实上游完成。重启会清除仅在页面提交的进程内 Key，配置文件中的 Key 会重新加载；原数据库及绑定记录保留。
