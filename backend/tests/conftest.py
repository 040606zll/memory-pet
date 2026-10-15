"""复现档案和主测试共享隔离夹具，单独或混合集合执行均不接触业务库。"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests" / "backend"))
from mysql_fixtures import mysql_config, mysql_store
