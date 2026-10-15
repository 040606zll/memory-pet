"""复现仅上传后端的嵌套目录部署，并验证真实子进程启动和失败清理。"""
import importlib.util
from pathlib import Path
import shutil
import signal
import socket
import subprocess
from types import SimpleNamespace

import httpx
import pytest


ROOT = next(path for path in Path(__file__).resolve().parents if (path / "backend/start.sh").is_file())


@pytest.fixture
def service(tmp_path, monkeypatch, request):
    needs_database = request.node.name in {"test_real_backend_starts_without_root_scripts_and_rejects_duplicate", "test_real_pet_backend_can_be_stopped_and_restarted", "test_identity_verification_failure_cleans_only_new_process"}
    database = request.getfixturevalue("mysql_config") if needs_database else None
    spec = importlib.util.spec_from_file_location("standalone_pet_launcher", ROOT / "backend/start_service.py")
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    target = tmp_path / "backend" / "backend"
    target.mkdir(parents=True)
    monkeypatch.setattr(launcher, "BACKEND_DIR", target)
    # 隔离端口和数据库；真实运行宠物应用，但不复制开发者配置或凭据。
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    monkeypatch.setattr(launcher, "PORT", port)
    shutil.copytree(ROOT / "backend/pet", target / "pet", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "backend/sql", target / "sql")
    # 统一响应体是后端包的一部分；模拟独立部署时一并复制，不加载真实配置。
    shutil.copytree(ROOT / "backend/app", target / "app", ignore=shutil.ignore_patterns("__pycache__"))
    (target / "run.py").write_text((ROOT / "backend/run.py").read_text().replace("8797", str(port)))
    if database:
        for name in ("host", "port", "database", "user", "password"):
            monkeypatch.setenv("PET_MYSQL_" + name.upper(), str(getattr(database, name)))
    started = []

    def spawn(*args, **kwargs):
        process = subprocess.Popen(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(launcher, "subprocess", SimpleNamespace(
        Popen=spawn, DEVNULL=subprocess.DEVNULL, STDOUT=subprocess.STDOUT,
        TimeoutExpired=subprocess.TimeoutExpired, run=subprocess.run,
    ))
    yield launcher, target, started
    for process in started:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def test_real_backend_starts_without_root_scripts_and_rejects_duplicate(service):
    launcher, target, started = service
    assert not (target.parent / "scripts").exists()
    launcher.start(timeout=10)
    runtime = target.parent / ".runtime"
    assert (runtime / "backend.pid").read_text() == str(started[0].pid)
    assert (runtime / "backend.log").is_file()
    response = httpx.get(f"http://127.0.0.1:{launcher.PORT}/api/health", trust_env=False)
    assert response.status_code == 200 and response.json()["data"]["status"] == "ok"
    with pytest.raises(SystemExit, match="已有服务运行"):
        launcher.start()
    assert len(started) == 1 and started[0].poll() is None


def test_import_failure_does_not_report_success_or_write_pid(service):
    launcher, target, started = service
    (target / "run.py").write_text("raise SystemExit(1)")
    with pytest.raises(SystemExit, match="启动失败"):
        launcher.start(timeout=3)
    assert started[0].poll() is not None
    assert not (target.parent / ".runtime/backend.pid").exists()


def test_real_pet_backend_can_be_stopped_and_restarted(service):
    launcher, target, started = service
    launcher.start(timeout=10)
    assert launcher.status() == 0
    launcher.stop(timeout=10)
    assert started[0].wait(timeout=5) in {0, -signal.SIGTERM}
    assert "Application shutdown complete" in (target.parent / ".runtime/backend.log").read_text()
    assert launcher.status() == 3
    launcher.restart()
    assert len(started) == 2
    assert httpx.get(f"http://127.0.0.1:{launcher.PORT}/api/health", trust_env=False).status_code == 200
    launcher.stop(timeout=10)
    assert started[1].wait(timeout=5) in {0, -signal.SIGTERM}
    assert not (target.parent / ".runtime/backend.pid").exists()


def test_identity_verification_failure_cleans_only_new_process(service, monkeypatch):
    launcher, target, started = service
    monkeypatch.setattr(launcher, "process_identity", lambda pid: None)
    with pytest.raises(SystemExit, match="归属核验失败"):
        launcher.start(timeout=10)
    assert started[0].poll() is not None
    assert not (target.parent / ".runtime/backend.pid").exists()


def test_startup_timeout_terminates_only_the_new_child(service):
    launcher, target, started = service
    (target / "run.py").write_text("import time; time.sleep(30)")
    with pytest.raises(SystemExit, match="启动超时"):
        launcher.start(timeout=.3)
    assert started[0].poll() is not None
    assert not (target.parent / ".runtime/backend.pid").exists()


def test_slow_shutdown_is_killed_only_after_terminate_times_out(service, monkeypatch):
    launcher, _, _ = service

    class Process:
        killed = False

        def poll(self):
            return None

        def terminate(self):
            pass

        def kill(self):
            self.killed = True

        def wait(self, timeout):
            if not self.killed:
                raise subprocess.TimeoutExpired("测试子进程", timeout)

    process = Process()
    monkeypatch.setattr(launcher.subprocess, "Popen", lambda *args, **kwargs: process)
    with pytest.raises(SystemExit, match="启动超时"):
        launcher.start(timeout=0)
    assert process.killed
