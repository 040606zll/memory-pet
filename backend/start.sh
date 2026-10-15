#!/usr/bin/env bash
# 使用已有 Conda 环境管理宠物后端，不安装依赖或改写服务配置。
set -Eeuo pipefail

# 部署时直接修改这两项，分别填写 Conda 可执行文件的绝对路径和已有环境名。
CONDA_BIN="/root/miniconda3/bin/conda"
ENV_NAME="xyd"

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-start}"

usage() {
  cat <<'EOF'
用法：
  ./backend/start.sh [start]   后台启动（默认），等待健康检查通过
  ./backend/start.sh stop      正常停止本项目后台进程
  ./backend/start.sh restart   停止成功后重新启动
  ./backend/start.sh status    查看状态（运行返回 0，未运行返回 3）
  ./backend/start.sh run       前台运行，适合终端调试
  ./backend/start.sh --help    显示帮助

Conda 路径和环境名：直接编辑本脚本顶部的 CONDA_BIN 和 ENV_NAME。
不读取 CONDA_EXE、PET_CONDA_ENV，也不自动查找系统 Conda。
首次安装依赖请自行执行：conda run -n xyd python -m pip install -r backend/requirements.lock.txt
后端地址：http://127.0.0.1:8797（单进程）
后台 PID：../.runtime/backend.pid；后台日志：../.runtime/backend.log（相对后端目录）
配置由应用读取本目录 config.toml、config.local.toml 及进程环境变量。
停止前校验进程归属和启动时间；停止超时不会强制杀进程或继续重启。
前台 run 用 Ctrl+C 停止；systemd 托管的进程请用 systemctl 管理。
本脚本只管理宠物后端，不启动前端或 MemoryOS，不创建或轮换 Key。
EOF
}

fail() {
  printf '[MemoryPet] %s\n' "$*" >&2
  exit 1
}

if (($# > 1)); then
  usage >&2
  exit 2
fi
case "$ACTION" in
  -h|--help) usage; exit 0 ;;
  start|run|stop|restart|status) ;;
  *) usage >&2; exit 2 ;;
esac

# 固定配置无效时直接报错，避免误用服务器上的其他 Python 环境。
[[ "$CONDA_BIN" == /* && -x "$CONDA_BIN" && ! -d "$CONDA_BIN" ]] \
  || fail 'Conda 路径无效，请修改脚本顶部的 CONDA_BIN，填写可执行文件的绝对路径'
[[ -n "$ENV_NAME" ]] || fail 'Conda 环境名为空，请修改脚本顶部的 ENV_NAME'

cd "$BACKEND_DIR"
if [[ "$ACTION" != run ]]; then
  # 后台启动器随后端一起部署，不依赖项目根目录或其 scripts 文件夹。
  ENTRY="$BACKEND_DIR/start_service.py"
else
  # run.py 固定回环监听和单进程；工作目录须使 pet 模块可导入。
  ENTRY="$BACKEND_DIR/run.py"
fi
[[ -f "$ENTRY" ]] || fail "后端启动文件缺失，请完整上传后端目录：$ENTRY"

printf '[MemoryPet] 使用 Conda 环境 %s，启动模式 %s\n' "$ENV_NAME" "$ACTION"
# conda run 无需交互式 conda init，且不会悄悄退回系统 Python。
ARGS=("$ENTRY")
[[ "$ACTION" == start || "$ACTION" == run ]] || ARGS+=("$ACTION")
if "$CONDA_BIN" run --no-capture-output -n "$ENV_NAME" python "${ARGS[@]}"; then
  exit 0
else
  exit_code=$?
  if [[ "$ACTION" == status && "$exit_code" == 3 ]]; then
    exit 3
  fi
  printf '[MemoryPet] %s 操作失败，请检查上方提示、Conda 环境及后台日志\n' "$ACTION" >&2
  exit "$exit_code"
fi
