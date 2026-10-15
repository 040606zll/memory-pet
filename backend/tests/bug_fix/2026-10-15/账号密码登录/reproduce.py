"""从项目根目录执行账号登录与归属隔离的离线回归。"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[5]

if __name__ == "__main__":
    raise SystemExit(subprocess.call([
        sys.executable, "-m", "pytest", "tests/backend/test_accounts_auth.py",
        "tests/backend/test_connections.py", "-q",
    ], cwd=ROOT))
