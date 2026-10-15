# Conda 启动脚本使用说明

本次没有新增或修改 HTTP 接口。脚本位置：`backend/start.sh`，参考 MemoryOS `start.sh` 的目录定位、日志及就绪检查方式。后台模式使用同目录 `start_service.py`，支持后端独立部署，不依赖项目根目录的 `scripts/`。

## 命令

- `./backend/start.sh` 或 `./backend/start.sh start`：后台启动。
- `./backend/start.sh run`：前台运行。
- `./backend/start.sh --help`：打印帮助，不启动进程。

Conda 路径和环境名固定写在脚本顶部，部署时直接修改这两项：

```bash
CONDA_BIN="/opt/anaconda3/bin/conda"
ENV_NAME="xyd"
```

不读取 `CONDA_EXE`、`PET_CONDA_ENV`，不查找 PATH 或其他安装目录。路径必须是可执行文件的绝对路径，环境名不能为空；配置无效时直接失败，不回退系统 Python。通过 `conda run --no-capture-output -n xyd python` 执行，不依赖交互式 shell 初始化。支持带空格的项目路径，可从任意工作目录调用完整脚本路径。

## 启动行为

后台模式先检查 8797 端口，再启动同目录 `run.py`，等待 `http://127.0.0.1:8797/api/health` 成功后记录 PID。日志和 PID 位于后端目录上一级 `.runtime/backend.log`、`.runtime/backend.pid`；启动失败或超时只清理本次创建的子进程。前台模式在后端目录运行 `run.py`。可进入后端目录执行 `./start.sh start`，即使部署目录嵌套为 backend/backend 也能定位入口。

脚本不安装依赖，不读取或写回配置内容，不创建或轮换 Key，不启动 MemoryOS 或前端。后续版本已补齐 stop/restart/status，完整命令和升级步骤见[服务停止与重启](../服务停止与重启/API接口文档.md)；本文其余部分保留原始启动配置说明。长期运行建议使用部署文档的 systemd 方案。监听仍为 `127.0.0.1:8797`，后端 Host／Origin 限制保持。

配置由后端加载，优先级：环境变量 > `backend/config.local.toml` > `backend/config.toml`。后台健康检查仅验证进程，连接上游仍需页面验证。参数错误退出 2，找不到有效 Conda 时退出 1；Conda 或应用启动失败保留失败退出码并补充中文提示。
