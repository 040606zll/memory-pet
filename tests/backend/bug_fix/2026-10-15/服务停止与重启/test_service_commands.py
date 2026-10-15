"""在临时目录和随机端口验证脚本生命周期，不触碰正在运行的项目服务。"""
import fcntl
import json
import re
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

import httpx
import pytest


ROOT = next(path for path in Path(__file__).resolve().parents if (path / "backend/start.sh").is_file())


@pytest.fixture
def service(tmp_path):
    backend = tmp_path / "project with spaces" / "backend" / "backend"
    backend.mkdir(parents=True)
    runtime = backend.parent / ".runtime"
    runtime.mkdir()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    conda = tmp_path / "conda"
    conda.write_text(f"#!{sys.executable}\nimport subprocess, sys\nsys.exit(subprocess.call([sys.executable, *sys.argv[6:]]))\n")
    conda.chmod(0o755)
    script = backend / "start.sh"
    script.write_text(re.sub(r'^CONDA_BIN="[^"]+"$', lambda _: f'CONDA_BIN="{conda}"', (ROOT / "backend/start.sh").read_text(), flags=re.M)
                      .replace('ENV_NAME="xyd"', 'ENV_NAME="memory"'))
    (backend / "start_service.py").write_text((ROOT / "backend/start_service.py").read_text()
        .replace("PORT = 8797", f"PORT = {port}").replace("STOP_TIMEOUT = 15", "STOP_TIMEOUT = 0.4"))
    normal_entry = f'''from http.server import BaseHTTPRequestHandler, HTTPServer
import signal
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{{"status":"ok"}}')
    def log_message(self, *args):
        pass
HTTPServer(('127.0.0.1', {port}), Handler).serve_forever()
'''
    entry = backend / "run.py"
    entry.write_text(normal_entry)
    # 每次启动立即登记测试自己的 PID；即使故意破坏运行记录也能完整回收。
    tracked = set()

    def invoke(action):
        result = subprocess.run(["bash", str(script), action], cwd=tmp_path,
                                capture_output=True, text=True, timeout=25)
        pid_file = runtime / "backend.pid"
        if action in {"start", "restart"} and result.returncode == 0 and pid_file.exists():
            tracked.add(int(pid_file.read_text()))
        return result

    yield backend, runtime, port, invoke, tracked
    for pid in tracked:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def pid(runtime):
    return int((runtime / "backend.pid").read_text())


def assert_ok(result):
    assert result.returncode == 0, result.stdout + result.stderr


def test_start_status_stop_and_repeated_stop(service):
    _, runtime, port, invoke, _ = service
    assert_ok(invoke("start"))
    assert_ok(invoke("status"))
    assert httpx.get(f"http://127.0.0.1:{port}/api/health", trust_env=False).status_code == 200
    assert_ok(invoke("stop"))
    assert not (runtime / "backend.pid").exists()
    assert not (runtime / "backend-process.json").exists()
    assert (runtime / "backend.log").exists()
    assert invoke("status").returncode == 3
    assert_ok(invoke("stop"))
    with socket.socket() as probe:
        assert probe.connect_ex(("127.0.0.1", port)) != 0


def test_restart_waits_for_exit_and_creates_healthy_new_process(service):
    _, runtime, port, invoke, _ = service
    assert_ok(invoke("start"))
    previous = pid(runtime)
    assert_ok(invoke("restart"))
    assert pid(runtime) != previous
    assert httpx.get(f"http://127.0.0.1:{port}/api/health", trust_env=False).status_code == 200
    assert_ok(invoke("stop"))


def test_restart_when_stopped_starts_service(service):
    _, _, _, invoke, _ = service
    assert invoke("status").returncode == 3
    assert_ok(invoke("restart"))
    assert_ok(invoke("stop"))


@pytest.mark.parametrize("action", ["stop", "restart", "status", "start"])
def test_foreign_pid_is_never_signalled_or_overwritten(service, action):
    _, runtime, _, invoke, _ = service
    with subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"]) as foreign:
        try:
            (runtime / "backend.pid").write_text(str(foreign.pid))
            result = invoke(action)
            assert result.returncode == 1
            assert "归属" in result.stderr or "本项目" in result.stderr
            assert foreign.poll() is None
            assert pid(runtime) == foreign.pid
        finally:
            foreign.terminate()
            foreign.wait(timeout=5)


@pytest.mark.parametrize("value", ["", "oops", "0", "1", "-22", "2\n3"])
def test_invalid_pid_fails_closed(service, value):
    _, runtime, _, invoke, _ = service
    (runtime / "backend.pid").write_text(value)
    result = invoke("stop")
    assert result.returncode == 1 and "PID" in result.stderr
    assert (runtime / "backend.pid").read_text() == value


def test_dead_pid_is_cleaned_and_stop_is_idempotent(service):
    _, runtime, _, invoke, _ = service
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait(timeout=5)
    (runtime / "backend.pid").write_text(str(process.pid))
    assert invoke("status").returncode == 3
    assert_ok(invoke("stop"))
    assert not (runtime / "backend.pid").exists()


def test_legacy_numeric_pid_without_identity_can_stop_owned_process(service):
    _, runtime, _, invoke, _ = service
    assert_ok(invoke("start"))
    (runtime / "backend-process.json").unlink(missing_ok=True)
    assert_ok(invoke("stop"))


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="旧版相对 run.py 通过 Linux /proc 核验工作目录")
def test_legacy_relative_entry_is_checked_against_real_working_directory(service):
    backend, runtime, port, invoke, tracked = service
    process = subprocess.Popen([sys.executable, "run.py"], cwd=backend,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tracked.add(process.pid)
    try:
        (runtime / "backend.pid").write_text(str(process.pid))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(.05)
        assert_ok(invoke("stop"))
        process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def test_changed_start_identity_refuses_even_same_project_pid(service):
    _, runtime, _, invoke, _ = service
    assert_ok(invoke("start"))
    record = runtime / "backend-process.json"
    metadata = json.loads(record.read_text())
    metadata["started"] = "wrong-start-time"
    record.write_text(json.dumps(metadata))
    assert invoke("stop").returncode == 1
    assert invoke("restart").returncode == 1
    record.unlink()
    assert_ok(invoke("status"))
    assert_ok(invoke("stop"))


def test_missing_pid_does_not_take_over_occupied_port(service):
    _, runtime, _, invoke, _ = service
    assert_ok(invoke("start"))
    original_pid = pid(runtime)
    (runtime / "backend.pid").unlink()
    for action in ("status", "stop", "restart", "start"):
        result = invoke(action)
        assert result.returncode == 1 and "端口" in result.stderr
    (runtime / "backend.pid").write_text(str(original_pid))
    assert_ok(invoke("stop"))


@pytest.mark.parametrize("action", ["start", "stop", "restart", "status"])
def test_concurrent_management_is_rejected_by_lock(service, action):
    _, runtime, _, invoke, _ = service
    with (runtime / "backend.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = invoke(action)
        assert result.returncode == 1 and "正在执行" in result.stderr


def test_restart_aborts_when_process_ignores_graceful_stop(service):
    backend, runtime, port, invoke, _ = service
    entry = backend / "run.py"
    entry.write_text(entry.read_text().replace("class Handler", "signal.signal(signal.SIGTERM, signal.SIG_IGN)\nclass Handler"))
    assert_ok(invoke("start"))
    original_pid = pid(runtime)
    result = invoke("restart")
    assert result.returncode == 1 and "停止超时" in result.stderr
    assert pid(runtime) == original_pid
    assert httpx.get(f"http://127.0.0.1:{port}/api/health", trust_env=False).status_code == 200


def test_duplicate_start_keeps_existing_pid(service):
    _, runtime, _, invoke, _ = service
    assert_ok(invoke("start"))
    original_pid = pid(runtime)
    assert invoke("start").returncode == 1
    assert pid(runtime) == original_pid
    assert_ok(invoke("stop"))
