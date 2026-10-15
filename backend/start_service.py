"""独立后端的进程管理器；仅管理经过路径与启动时间核验的本项目进程。"""
from contextlib import contextmanager
import errno
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

import httpx


BACKEND_DIR = Path(__file__).resolve().parent
PORT = 8797
STOP_TIMEOUT = 15


def runtime_dir():
    return BACKEND_DIR.parent / ".runtime"


@contextmanager
def management_lock():
    # 所有管理命令共用同一把非阻塞锁，防止并发重启产生双进程或覆盖 PID。
    runtime = runtime_dir()
    runtime.mkdir(exist_ok=True)
    with (runtime / "backend.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("其他服务管理命令正在执行，请稍后重试")
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def process_identity(pid):
    """只读取必要的进程信息；不读取进程环境，也不输出其他进程命令。"""
    entry = (BACKEND_DIR / "run.py").resolve()
    python = Path(sys.executable).resolve()
    if sys.platform.startswith("linux"):
        proc = Path("/proc") / str(pid)
        try:
            # comm 字段可能包含空格与括号，必须从最后一个右括号拆分。
            fields = (proc / "stat").read_text().rsplit(") ", 1)[1].split()
            if fields[0] in {"Z", "X"}:
                return None
            argv = (proc / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
            argv = [os.fsdecode(value) for value in argv]
            executable = (proc / "exe").resolve(strict=True)
            cwd = (proc / "cwd").resolve(strict=True)
        except FileNotFoundError:
            if not proc.exists():
                return None
            raise SystemExit("无法确认 PID 归属，未执行任何停止操作")
        # 兼容旧联调入口的相对 run.py，但必须核对真实工作目录。
        script = Path(argv[1]) if len(argv) == 2 else None
        owned = executable == python and script is not None and (
            script if script.is_absolute() else cwd / script).resolve() == entry
        return {"pid": pid, "started": fields[19], "owned": owned}

    # macOS 没有 /proc；ps 仅查询这个 PID，不运行 Shell，也不枚举全机命令。
    result = subprocess.run(
        ["/bin/ps", "-ww", "-p", str(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="],
        capture_output=True, text=True, timeout=3, env={**os.environ, "LC_ALL": "C"},
    )
    if result.returncode == 1 and not result.stdout.strip():
        return None
    values = result.stdout.strip().split(maxsplit=6)
    if result.returncode or len(values) != 7:
        raise SystemExit("无法确认 PID 归属，未执行任何停止操作")
    if values[0].startswith(("Z", "X")):
        return None
    commands = {f"{interpreter} {entry}" for interpreter in {str(python), sys.executable}}
    return {"pid": pid, "started": " ".join(values[1:6]), "owned": values[6] in commands}


def current_process():
    pid_file = runtime_dir() / "backend.pid"
    if not pid_file.exists():
        return None
    value = pid_file.read_text().strip()
    if not value.isascii() or not value.isdigit() or len(value) > 10 or not 1 < int(value) <= 2147483647:
        raise SystemExit("PID 文件无效，请核查本项目运行记录；未停止任何进程")
    identity = process_identity(int(value))
    if identity is None:
        return None
    if not identity["owned"]:
        raise SystemExit("PID 归属与本项目不符，拒绝停止、接管或覆盖记录")
    metadata = runtime_dir() / "backend-process.json"
    if metadata.exists():
        try:
            record = json.loads(metadata.read_text())
        except (ValueError, UnicodeError):
            raise SystemExit("PID 启动记录无效，未执行任何停止操作")
        if not isinstance(record, dict) or record != {
            "pid": identity["pid"], "started": identity["started"],
        }:
            raise SystemExit("PID 启动时间与记录不符，可能已被复用；未执行任何停止操作")
    # 旧版只有数字 PID，仍须通过同一套进程路径校验。
    return identity


def port_in_use():
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex(("127.0.0.1", PORT)) == 0


def reject_untracked_port():
    if port_in_use():
        raise SystemExit(f"端口 {PORT} 已有服务运行，但没有可验证的本项目 PID；拒绝接管")


def clear_record():
    # 只移除运行记录，保留日志、锁文件、数据库和所有应用配置。
    for name in ("backend.pid", "backend-process.json"):
        (runtime_dir() / name).unlink(missing_ok=True)


def write_record(name, value):
    target = runtime_dir() / name
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(value)
    temporary.replace(target)


def start(timeout=15):
    with management_lock():
        _start(timeout)


def _start(timeout):
    if current_process():
        raise SystemExit("本项目已有服务运行，请使用 status 查看或使用 restart 重启")
    reject_untracked_port()
    clear_record()

    runtime = runtime_dir()
    runtime.mkdir(exist_ok=True)
    logfile = runtime / "backend.log"
    with logfile.open("a") as output:
        # sys.executable 来自 start.sh 选定的 Conda 环境；不读取上游凭据或建号。
        process = subprocess.Popen(
            [sys.executable, str(BACKEND_DIR / "run.py")], cwd=BACKEND_DIR,
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    url = f"http://127.0.0.1:{PORT}/api/health"
    try:
        deadline = time.monotonic() + timeout
        # 不使用系统代理，启动期仅检查本机健康接口，不访问模型或 MemoryOS。
        with httpx.Client(timeout=1, trust_env=False) as client:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise SystemExit(f"宠物后端启动失败，请查看 {logfile}")
                try:
                    result = client.get(url)
                    if result.status_code == 200 and process.poll() is None:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(.2)
            else:
                raise SystemExit(f"宠物后端启动超时，请查看 {logfile}")
        # 启动成功后记录身份及数字 PID；数字格式兼容原有运维工具。
        identity = process_identity(process.pid)
        if identity is None or not identity["owned"]:
            raise SystemExit("宠物后端进程归属核验失败，未报告启动成功")
        write_record("backend-process.json", json.dumps({
            "pid": process.pid, "started": identity["started"],
        }))
        write_record("backend.pid", str(process.pid))
    except BaseException:
        # 仅清理本次创建的子进程，避免超时后遗留后台实例；不操作原服务。
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        clear_record()
        raise
    print(f"宠物后端已启动：PID {process.pid}，{url}，日志：{logfile}")


def send_stop(identity):
    pid = identity["pid"]
    # Linux 优先使用 pidfd，信号与进程实例绑定，避免校验后 PID 被复用。
    descriptor = None
    try:
        if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
            try:
                descriptor = os.pidfd_open(pid)
            except OSError as error:
                # Python 提供接口但旧 Linux 内核尚不支持时，仍可在重新核验后正常停止。
                if error.errno != errno.ENOSYS:
                    raise
        if process_identity(pid) != identity:
            raise SystemExit("PID 归属或启动时间已变化，取消停止操作")
        if descriptor is not None:
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _stop(timeout):
    identity = current_process()
    if identity is None:
        reject_untracked_port()
        clear_record()
        print("宠物后端未运行")
        return
    send_stop(identity)
    deadline = time.monotonic() + timeout
    while True:
        current = process_identity(identity["pid"])
        # 原进程已退出或 PID 被复用即结束等待，不向新进程发送信号。
        if current is None or current != identity:
            clear_record()
            print(f"宠物后端已停止：PID {identity['pid']}")
            return
        if time.monotonic() >= deadline:
            raise SystemExit("宠物后端停止超时，已保留 PID；未强制终止，也不会继续重启，请检查后台日志")
        time.sleep(.1)


def stop(timeout=STOP_TIMEOUT):
    with management_lock():
        _stop(timeout)


def restart():
    with management_lock():
        _stop(STOP_TIMEOUT)
        _start(15)


def status():
    with management_lock():
        identity = current_process()
        if identity is not None:
            print(f"宠物后端运行中：PID {identity['pid']}，http://127.0.0.1:{PORT}")
            return 0
        reject_untracked_port()
        print("宠物后端未运行")
        return 3


def main():
    actions = {"start": start, "stop": stop, "restart": restart, "status": status}
    action = sys.argv[1] if len(sys.argv) == 2 else "start"
    if len(sys.argv) > 2 or action not in actions:
        raise SystemExit("用法：python start_service.py [start|stop|restart|status]")
    try:
        return actions[action]()
    except (OSError, subprocess.SubprocessError):
        raise SystemExit("服务管理失败，请检查本项目目录权限、进程检查工具及后台日志")


if __name__ == "__main__":
    sys.exit(main())
