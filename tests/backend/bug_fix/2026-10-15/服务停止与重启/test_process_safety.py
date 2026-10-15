"""核验 Linux 进程身份与信号发送边界；模拟 /proc，不向真实 PID 发信号。"""
import errno
import fcntl
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


ROOT = next(path for path in Path(__file__).resolve().parents if (path / "backend/start.sh").is_file())


@pytest.fixture
def manager(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("test_pet_manager", ROOT / "backend/start_service.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    backend = tmp_path / "backend"
    backend.mkdir()
    monkeypatch.setattr(module, "BACKEND_DIR", backend)
    module.runtime_dir().mkdir()
    return module


@pytest.fixture
def linux_process(manager, tmp_path, monkeypatch):
    proc_root = tmp_path / "proc"
    proc = proc_root / "12345"
    proc.mkdir(parents=True)
    # stat 的 starttime 是第 22 个字段，即 comm 后的下标 19。
    fields = ["S"] + ["0"] * 18 + ["87654321"]
    (proc / "stat").write_text("12345 (python with ) spaces) " + " ".join(fields))
    (proc / "cmdline").write_bytes(f"{sys.executable}\0{manager.BACKEND_DIR / 'run.py'}\0".encode())
    (proc / "exe").symlink_to(Path(sys.executable).resolve())
    (proc / "cwd").symlink_to(manager.BACKEND_DIR)
    monkeypatch.setattr(manager, "Path", lambda value: proc_root if value == "/proc" else Path(value))
    monkeypatch.setattr(manager, "sys", SimpleNamespace(platform="linux", executable=sys.executable))
    return manager, proc


@pytest.mark.parametrize("relative", [False, True])
def test_linux_checks_interpreter_entry_and_start_ticks(linux_process, relative):
    manager, proc = linux_process
    if relative:
        (proc / "cmdline").write_bytes(f"{sys.executable}\0run.py\0".encode())
    assert manager.process_identity(12345) == {"pid": 12345, "started": "87654321", "owned": True}


@pytest.mark.parametrize("entry", ["other.py", "-c\0import time", "run.py\0unexpected"])
def test_linux_rejects_other_commands(linux_process, entry):
    manager, proc = linux_process
    (proc / "cmdline").write_bytes(f"{sys.executable}\0{entry}\0".encode())
    assert manager.process_identity(12345)["owned"] is False


def test_linux_relative_entry_must_match_working_directory(linux_process, tmp_path):
    manager, proc = linux_process
    (proc / "cmdline").write_bytes(f"{sys.executable}\0run.py\0".encode())
    (proc / "cwd").unlink()
    (proc / "cwd").symlink_to(tmp_path)
    assert manager.process_identity(12345)["owned"] is False


def test_linux_wrong_interpreter_is_not_owned(linux_process):
    manager, proc = linux_process
    (proc / "exe").unlink()
    (proc / "exe").symlink_to("/bin/sh")
    assert manager.process_identity(12345)["owned"] is False


def test_linux_zombie_and_missing_process_are_stopped(linux_process):
    manager, proc = linux_process
    (proc / "stat").write_text("12345 (python) Z " + "0 " * 18 + "87654321")
    assert manager.process_identity(12345) is None
    assert manager.process_identity(54321) is None


def test_linux_incomplete_identity_fails_closed(linux_process):
    manager, proc = linux_process
    (proc / "cmdline").unlink()
    with pytest.raises(SystemExit, match="无法确认 PID 归属"):
        manager.process_identity(12345)


@pytest.mark.parametrize("code,output,expected", [
    (1, "", None), (0, "Z Thu Oct 15 12:00:00 2026 python", None),
    (0, "S Thu Oct 15 12:00:00 2026 other.py", False),
])
def test_ps_missing_zombie_and_foreign_process(manager, monkeypatch, code, output, expected):
    monkeypatch.setattr(manager, "sys", SimpleNamespace(platform="darwin", executable=sys.executable))
    monkeypatch.setattr(manager.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=code, stdout=output))
    result = manager.process_identity(12345)
    assert result is None if expected is None else result["owned"] is expected


def test_ps_unreadable_result_fails_closed(manager, monkeypatch):
    monkeypatch.setattr(manager, "sys", SimpleNamespace(platform="darwin", executable=sys.executable))
    monkeypatch.setattr(manager.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=2, stdout=""))
    with pytest.raises(SystemExit, match="无法确认 PID 归属"):
        manager.process_identity(12345)


@pytest.mark.parametrize("value", ["", "bad", "1", "0", "-3", "9" * 5000, "2147483648", "2\n3"])
def test_invalid_pid_never_reaches_process_inspection(manager, monkeypatch, value):
    (manager.runtime_dir() / "backend.pid").write_text(value)
    monkeypatch.setattr(manager, "process_identity", lambda pid: pytest.fail("不应检查无效 PID"))
    with pytest.raises(SystemExit, match="PID 文件无效"):
        manager.current_process()


@pytest.mark.parametrize("metadata", ["oops", "null", "[]", '{"pid":12345,"started":"old"}'])
def test_invalid_or_reused_start_record_cannot_stop_process(manager, monkeypatch, metadata):
    (manager.runtime_dir() / "backend.pid").write_text("12345")
    (manager.runtime_dir() / "backend-process.json").write_text(metadata)
    monkeypatch.setattr(manager, "process_identity", lambda pid: {"pid": pid, "started": "new", "owned": True})
    with pytest.raises(SystemExit, match="启动记录无效|启动时间与记录不符"):
        manager.stop()


def test_foreign_process_record_cannot_be_overwritten(manager, monkeypatch):
    (manager.runtime_dir() / "backend.pid").write_text("12345")
    monkeypatch.setattr(manager, "process_identity", lambda pid: {"pid": pid, "started": "new", "owned": False})
    with pytest.raises(SystemExit, match="PID 归属与本项目不符"):
        manager.start()


def test_lock_prevents_concurrent_management(manager):
    with (manager.runtime_dir() / "backend.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(SystemExit, match="正在执行"):
            manager.stop()


@pytest.mark.parametrize("changed", [False, True])
def test_pidfd_signal_is_bound_to_verified_process_and_descriptor_always_closed(manager, monkeypatch, changed):
    identity = {"pid": 12345, "started": "new", "owned": True}
    signals, closed = [], []
    monkeypatch.setattr(manager, "os", SimpleNamespace(pidfd_open=lambda pid: 101, close=closed.append))
    monkeypatch.setattr(manager, "signal", SimpleNamespace(SIGTERM=15, pidfd_send_signal=lambda *args: signals.append(args)))
    monkeypatch.setattr(manager, "process_identity", lambda pid: {**identity, "started": "old"} if changed else identity)
    if changed:
        with pytest.raises(SystemExit, match="已变化"):
            manager.send_stop(identity)
        assert not signals
    else:
        manager.send_stop(identity)
        assert signals == [(101, 15)]
    assert closed == [101]


@pytest.mark.parametrize("error_number", [errno.ENOSYS, errno.EPERM, errno.ESRCH])
def test_pidfd_old_kernel_fallback_and_permission_failure(manager, monkeypatch, error_number):
    identity = {"pid": 12345, "started": "new", "owned": True}
    signals = []
    def open_descriptor(pid):
        raise OSError(error_number, "测试系统错误")
    monkeypatch.setattr(manager, "os", SimpleNamespace(pidfd_open=open_descriptor, kill=lambda *args: signals.append(args)))
    monkeypatch.setattr(manager, "signal", SimpleNamespace(SIGTERM=15, pidfd_send_signal=lambda *args: pytest.fail("不应调用")))
    monkeypatch.setattr(manager, "process_identity", lambda pid: identity)
    if error_number == errno.EPERM:
        with pytest.raises(PermissionError):
            manager.send_stop(identity)
    else:
        manager.send_stop(identity)
    assert signals == ([(12345, 15)] if error_number == errno.ENOSYS else [])


def test_stop_timeout_preserves_record_and_never_force_kills(manager, monkeypatch):
    identity = {"pid": 12345, "started": "new", "owned": True}
    (manager.runtime_dir() / "backend.pid").write_text("12345")
    monkeypatch.setattr(manager, "process_identity", lambda pid: identity)
    sent = []
    monkeypatch.setattr(manager, "send_stop", sent.append)
    with pytest.raises(SystemExit, match="停止超时"):
        manager.stop(timeout=0)
    assert sent == [identity]
    assert (manager.runtime_dir() / "backend.pid").read_text() == "12345"


def test_stale_record_is_cleaned_without_signalling(manager, monkeypatch):
    (manager.runtime_dir() / "backend.pid").write_text("12345")
    monkeypatch.setattr(manager, "process_identity", lambda pid: None)
    monkeypatch.setattr(manager, "port_in_use", lambda: False)
    assert manager.status() == 3
    manager.stop()
    assert not (manager.runtime_dir() / "backend.pid").exists()


def test_occupied_port_without_record_is_not_adopted(manager, monkeypatch):
    monkeypatch.setattr(manager, "port_in_use", lambda: True)
    with pytest.raises(SystemExit, match="端口.*拒绝接管"):
        manager.stop()


@pytest.mark.parametrize("args", [["manager", "other"], ["manager", "start", "extra"]])
def test_python_entry_rejects_unknown_arguments(manager, monkeypatch, args):
    monkeypatch.setattr(manager, "sys", SimpleNamespace(argv=args))
    with pytest.raises(SystemExit, match="用法"):
        manager.main()


def test_python_entry_reports_io_failure_in_chinese(manager, monkeypatch):
    monkeypatch.setattr(manager, "sys", SimpleNamespace(argv=["manager", "stop"]))
    def fail():
        raise PermissionError("测试禁止输出的内部错误")
    monkeypatch.setattr(manager, "stop", fail)
    with pytest.raises(SystemExit, match="服务管理失败") as error:
        manager.main()
    assert "内部错误" not in str(error.value)
