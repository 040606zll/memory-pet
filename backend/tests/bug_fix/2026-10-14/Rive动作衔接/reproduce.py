"""调用实际前端组件回归，不以独立模拟替代页面播放适配。"""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[5]
result = subprocess.run([
    'pnpm', '--dir', str(root / 'frontend'), 'exec', 'vitest', 'run',
    'tests/panda.test.jsx', 'tests/petMachine.test.js', 'tests/animation-smoothness.test.jsx',
    '--reporter=dot',
], cwd=root)
raise SystemExit(result.returncode)
