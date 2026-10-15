# 宠物后端停止、重启与状态命令

## 问题与修改

旧版 start.sh 只支持 start/run，stop/restart/status 均返回用法错误（退出码 2）。本次修改 backend/start.sh、backend/start_service.py 并补充测试与部署文档，未修改业务接口、前端、模型配置、MemoryOS Key 或数据库结构。

## 服务器更新步骤

将交付包 service-management-update.zip 解压至**含 run.py 的后端目录**，当前服务器目录为：

```text
/root/www/server/memory-pet/backend/backend/
```

更新包仅含 start.sh、start_service.py 与本文，不包含应用配置、数据库或密钥。先保存服务器旧 start.sh，更新后将其中原有 Conda 路径和环境名填写回新脚本顶部：

```bash
CONDA_BIN="/服务器上实际的路径/bin/conda"
ENV_NAME="memory"
```

路径应填写服务器原值；上面的路径仅是占位示例。脚本继续使用固定值，不读取 CONDA_EXE/PET_CONDA_ENV，也不自动激活或创建环境。需要现有 httpx 依赖与 Unix 文件锁支持，不新增依赖。

在该目录执行以下命令：

```bash
bash start.sh status
bash start.sh stop
bash start.sh start
# 需要一次完成停止和启动时：
bash start.sh restart
```

安装位置不变、Conda 环境不变且已有上一级 .runtime/backend.pid 时，可核验并停止旧版脚本启动的服务。升级不需要先重启，替换管理脚本本身不会中断服务。不要同时移动运行目录或变更 Conda 环境，否则旧进程可能无法通过归属核验。两个文件必须一起更新。

## 命令约定

| 命令 | 行为 | 退出码 |
| --- | --- | --- |
| start 或无参数 | 后台启动并等待健康接口，重复启动拒绝覆盖已有 PID | 成功 0，失败 1 |
| stop | 核验进程后发送 SIGTERM，最多等待 15 秒 | 成功或已停止 0，失败 1 |
| restart | 同一把管理锁内先停止，成功后启动；停止超时则退出 | 成功 0，失败 1 |
| status | 检查受管进程是否仍在运行，不验证模型或记忆服务 | 运行 0，未运行 3，无法核验 1 |
| run | 前台运行，用 Ctrl+C 停止，不写入受管 PID | 使用前台进程退出码 |
| --help | 显示帮助，不依赖 Conda | 0 |
| 非法参数 | 显示帮助，不操作进程 | 2 |

Conda 本身失败时保留其退出码。使用条件命令、自动化脚本或面板健康检查时，应区分 status 的 3 和异常的 1；Conda 可能同时输出非零退出码提示。

## 进程校验与文件

- `../.runtime/backend.pid`：兼容原有格式的数字 PID。
- `../.runtime/backend-process.json`：新启动生成的 PID 与启动时间，防止 PID 复用。
- `../.runtime/backend.lock`：非阻塞管理锁，阻止并发管理命令。
- `../.runtime/backend.log`：后台日志，停止后保留。

以上路径均相对实际后端目录。Linux 通过 /proc 核验 Python 可执行文件、入口和启动时间；相对 run.py 还会核验进程工作目录。macOS 通过指定 PID 的 ps 输出核验绝对入口和启动时间；路径包含空格时也支持新版绝对入口。读取过程不输出进程命令和环境变量。

Linux 支持 pidfd 时，SIGTERM 与已核验的进程实例绑定；旧内核和 macOS 在发送前再次核验身份。不会按端口批量杀进程，也不会杀进程组。无法读取、记录损坏、PID 指向其他服务或启动时间不符时拒绝操作；请管理员核查运行记录，不要通过删除活跃 PID 文件绕过校验。

已退出的旧 PID 可由 stop 清理；若端口仍被未登记进程占用则报错，不会接管。SIGTERM 超时保留运行记录，不发送 SIGKILL，也不继续重启；检查后台日志、在途请求或使用正确的服务管理器处理。若启动过程中失败，只回收本次创建的新进程，避免遗留实例。

前台 run 的进程使用原终端 Ctrl+C；systemd 托管的进程使用 systemctl stop/restart/status memory-pet，避免自动恢复机制与脚本冲突。本脚本不提供崩溃自动拉起。

## 影响和验收

stop/restart 会结束当前连接和在途请求；页面填写的 MemoryOS Key 为进程内状态，重启后需要重新填写并验证。后端文件配置与 SQLite 保留，前端无需重新打包。应用仍单进程监听 127.0.0.1:8797，访问白名单和认证逻辑不变。

服务器更新后可依次验证 status、stop、status、start、restart，以及健康接口：

```bash
curl --fail http://127.0.0.1:8797/api/health
```

确认停止后端口释放，重启后 PID 改变且健康接口成功；浏览器重新连接并完成文字对话。不要在同一实例上并行执行多个生命周期命令。当前交付仅在隔离测试服务上验收，尚未更新或重启用户服务器。
