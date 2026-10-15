"""在临时项目中验证 Shell 启动入口，不读取密钥或停止开发服务。"""
import json
import re
import os
from pathlib import Path
import subprocess
import sys

import pytest


SOURCE = Path(__file__).resolve().parents[2] / "backend" / "start.sh"


@pytest.fixture
def launcher(tmp_path):
    # 模拟服务器 backend/backend 嵌套部署：父目录不包含项目根的 scripts。
    root = tmp_path / "project with spaces" / "backend"
    (root / "backend").mkdir(parents=True)
    script = root / "backend" / "start.sh"
    # 替身只报告入口和目录，确保不会创建真实数据库或请求上游。
    entry = "import json, os, sys; print(json.dumps({'entry': sys.argv[0], 'cwd': os.getcwd()}))"
    (root / "backend" / "run.py").write_text(entry)
    (root / "backend" / "start_service.py").write_text(entry)
    binaries = tmp_path / "bin"
    binaries.mkdir()
    conda = binaries / "conda"
    conda.write_text(f"#!{sys.executable}\n" + '''import json, os, subprocess, sys
print(json.dumps({'conda_args': sys.argv[1:]}), flush=True)
if os.environ.get('FAKE_CONDA_FAILURE'):
    sys.exit(7)
sys.exit(subprocess.call([sys.executable, *sys.argv[6:]]))
''')
    conda.chmod(0o755)
    env = os.environ.copy()
    for field in ("CONDA_EXE", "PET_CONDA_ENV", "FAKE_CONDA_FAILURE"):
        env.pop(field, None)
    env["PATH"] = str(binaries) + os.pathsep + env["PATH"]

    def invoke(*args, conda_path=None, env_name="xyd", **overrides):
        # 仅改临时副本的固定配置，模拟运维在脚本中填写路径和环境名。
        source = SOURCE.read_text()
        assert re.search(r'^CONDA_BIN="[^"]+"$', source, re.M)
        assert 'ENV_NAME="xyd"' in source
        script.write_text(re.sub(r'^CONDA_BIN="[^"]+"$', lambda _: f'CONDA_BIN="{conda_path if conda_path is not None else conda}"', source, flags=re.M)
                         .replace('ENV_NAME="xyd"', f'ENV_NAME="{env_name}"'))
        return subprocess.run(["bash", str(script), *args], cwd=tmp_path,
                              env={**env, **overrides}, capture_output=True, text=True, timeout=10)

    return root, conda, invoke


def records(result):
    return [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]


@pytest.mark.parametrize("args", [(), ("start",)])
def test_background_launch_works_with_backend_only_nested_deployment(launcher, args):
    root, _, invoke = launcher
    result = invoke(*args)
    assert result.returncode == 0, result.stderr
    conda, entry = records(result)
    assert conda["conda_args"] == ["run", "--no-capture-output", "-n", "xyd", "python",
                                    str(root / "backend" / "start_service.py")]
    assert entry["cwd"] == str(root / "backend")
    assert "--memoryos-project" not in result.stdout


def test_foreground_launch_uses_backend_directory_and_named_environment(launcher):
    root, conda, invoke = launcher
    result = invoke("run", env_name="custom-env")
    assert result.returncode == 0
    command, entry = records(result)
    assert command["conda_args"][3] == "custom-env"
    assert entry == {"entry": str(root / "backend" / "run.py"), "cwd": str(root / "backend")}


@pytest.mark.parametrize("args", [("--help",), ("-h",)])
def test_help_does_not_require_conda_or_start_service(launcher, args):
    _, _, invoke = launcher
    result = invoke(*args, conda_path="/nonexistent/conda")
    assert result.returncode == 0 and "用法" in result.stdout
    assert not records(result)


@pytest.mark.parametrize("args", [("unknown",), ("--memoryos-project",), ("start", "unexpected")])
def test_invalid_arguments_fail_before_starting(launcher, args):
    _, _, invoke = launcher
    result = invoke(*args)
    assert result.returncode == 2 and "用法" in result.stderr
    assert not records(result)


@pytest.mark.parametrize("path", ["/nonexistent/conda", "/tmp", "conda"])
def test_invalid_fixed_conda_fails_without_using_system_python(launcher, path):
    _, _, invoke = launcher
    result = invoke(conda_path=path)
    assert result.returncode == 1 and "Conda 路径无效" in result.stderr
    assert not records(result)


def test_conda_failure_preserves_exit_status_with_chinese_hint(launcher):
    _, _, invoke = launcher
    result = invoke(FAKE_CONDA_FAILURE="1")
    assert result.returncode == 7 and "操作失败" in result.stderr
    assert len(records(result)) == 1


def test_system_variables_cannot_override_fixed_configuration(launcher):
    _, _, invoke = launcher
    result = invoke(CONDA_EXE="/nonexistent/conda", PET_CONDA_ENV="wrong-env")
    assert result.returncode == 0
    assert records(result)[0]["conda_args"][3] == "xyd"


def test_empty_environment_name_fails_before_starting(launcher):
    _, _, invoke = launcher
    result = invoke(env_name="")
    assert result.returncode == 1 and "Conda 环境名为空" in result.stderr
    assert not records(result)


@pytest.mark.parametrize("action", ["stop", "restart", "status"])
def test_management_commands_use_selected_conda_and_local_entry(launcher, action):
    root, _, invoke = launcher
    result = invoke(action, env_name="memory")
    assert result.returncode == 0, result.stderr
    command, entry = records(result)
    assert command["conda_args"] == ["run", "--no-capture-output", "-n", "memory", "python",
                                      str(root / "backend/start_service.py"), action]
    assert entry["cwd"] == str(root / "backend")


def test_stopped_status_preserves_exit_code_without_operation_failure_hint(launcher):
    root, _, invoke = launcher
    (root / "backend/start_service.py").write_text("import sys; print('宠物后端未运行'); sys.exit(3)")
    result = invoke("status")
    assert result.returncode == 3 and "未运行" in result.stdout
    assert "操作失败" not in result.stderr
