"""复现公网 HTTP 下消息编号失败；运行实际前端发送流程的回归测试。"""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[5]
result = subprocess.run([
    'npm', '--prefix', str(root / 'frontend'), 'test', '--',
    'tests/app.test.jsx', 'tests/memoryChat.test.jsx',
    '-t', 'HTTP 环境缺少 randomUUID', '--reporter=dot',
], cwd=root, check=False)
sys.exit(result.returncode)
