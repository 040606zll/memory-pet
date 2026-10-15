# 独立后端启动路径修复

不修改 HTTP 接口、应用配置或业务逻辑。启动命令保持 `./start.sh start` 和 `./start.sh run`。

## 原因与复现

旧版 start.sh 从自身父目录拼出 scripts/start_backend.py，要求完整上传项目根目录。服务器仅包含后端文件，且路径为 `/root/www/server/memory-pet/backend/backend`，因此访问了不存在的 `/root/www/server/memory-pet/backend/scripts/start_backend.py`。Conda 已成功选择 memory 环境，此错误不是环境激活失败。

## 修复

- start.sh 的后台模式调用同目录 start_service.py；前台继续运行同目录 run.py。
- start_service.py 使用 Conda 的 sys.executable 启动 run.py，固定工作目录为后端目录。
- 保留 8797 端口预检、后台日志及健康检查；成功后记录 PID；失败或超时清理本次子进程。
- 不再依赖项目根目录的 scripts，不读取管理员配置，不建号或轮换 Key。
- 原 scripts/start_backend.py 保留为联调入口，未修改其调用方式。

部署时将新版 start.sh 和 start_service.py 一起上传到现有后端目录，保留 run.py、pet/、sql/ 及原配置。将 Shell 顶部 Conda 路径设为服务器实际绝对路径，ENV_NAME 设为服务器已有环境名 memory。不要覆盖服务器密钥配置。

启动后通过服务器本机 `curl --fail http://127.0.0.1:8797/api/health` 验证。日志和 PID 位于后端目录上一级 `.runtime/`。本修复不改变公网来源限制或 Nginx 配置。
