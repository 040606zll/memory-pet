"""本机联调入口：复用 MemoryOS 配置，密钥仅通过子进程环境传递。

不会改写现有 .env，不保存明文 API Key。默认入口仅启动宠物后端；
显式传入 --memoryos-project 时，可为本项目创建/轮换专用 Key 并复用专属用户。
"""
import argparse
import os
from pathlib import Path
import subprocess
import socket
import time

import httpx
from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[1]


def local_connection(project, base_url):
    if not base_url.startswith("http://127.0.0.1:"):
        raise RuntimeError("自动配置仅允许本机 MemoryOS，远端请使用连接表单")
    values = {**dotenv_values(project / ".env"), **dotenv_values(project / "backend" / ".env")}
    with httpx.Client(base_url=base_url, timeout=30, trust_env=False) as client:
        def call(method, path, **kwargs):
            result = client.request(method, path, **kwargs)
            if result.status_code >= 400:
                raise RuntimeError(f"本机记忆配置请求失败：{path}，HTTP {result.status_code}")
            return result.json()

        if call("GET", "/health/ready").get("status") != "ready":
            raise RuntimeError("MemoryOS 尚未就绪，请先检查其依赖服务")
        login = call("POST", "/admin/login", json={"username": values.get("ADMIN_USERNAME", ""), "password": values.get("ADMIN_PASSWORD", "")})
        admin_headers = {"Authorization": "Bearer " + login["token"]}
        keys = call("GET", "/admin/api-keys", headers=admin_headers)
        owned = next((key for key in keys if key["name"] == "memory-pet-local" and key["status"] == "active"), None)
        if owned:
            key = call("POST", "/admin/api-keys/" + owned["id"] + "/rotate", headers=admin_headers)
        else:
            key = call("POST", "/admin/api-keys", headers=admin_headers, json={"name": "memory-pet-local", "description": "独立熊猫宠物的本机开发凭证", "user_quota": 4, "kb_enabled": False})
        headers = {"X-API-Key": key["key"]}
        users = call("GET", "/users", headers=headers, params={"search": "熊猫宠物", "limit": 100})
        user = next((item for item in users["items"] if item.get("display_name") == "熊猫宠物"), None)
        if not user:
            user = call("POST", "/users", headers=headers, json={"display_name": "熊猫宠物", "kb_enabled": False})
    root_values = dotenv_values(project / ".env")
    config = {"MEMORYOS_BASE_URL": base_url, "MEMORYOS_API_KEY": key["key"], "MEMORYOS_USER_ID": user["id"]}
    for field, legacy in [("LLM_BASE_URL", "DEEPSEEK_BASE_URL"), ("LLM_API_KEY", "DEEPSEEK_API_KEY"), ("LLM_MODEL", "DEEPSEEK_MODEL")]:
        config[field] = root_values.get(field) or values.get(field) or values.get(legacy) or ""
    return config


def main():
    parser = argparse.ArgumentParser(description="启动独立熊猫宠物后端")
    parser.add_argument("--memoryos-project", type=Path)
    parser.add_argument("--memoryos-url", default="http://127.0.0.1:8863")
    args = parser.parse_args()
    # 必须先检查监听端口，避免重复启动时先轮换 Key，导致原进程突然失去权限。
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", 8797)) == 0:
            raise SystemExit("8797 已有服务运行，请复用当前服务或先停止本项目后端")
    environment = os.environ.copy()
    if args.memoryos_project:
        environment.update(local_connection(args.memoryos_project, args.memoryos_url))
    runtime = ROOT / ".runtime"
    runtime.mkdir(exist_ok=True)
    # 数据库缺省路径由后端配置加载器管理，避免启动脚本覆盖配置文件。
    with (runtime / "backend.log").open("a") as logfile:
        process = subprocess.Popen([os.sys.executable, "run.py"], cwd=ROOT / "backend", env=environment, stdout=logfile, stderr=subprocess.STDOUT, start_new_session=True)
    (runtime / "backend.pid").write_text(str(process.pid))
    # 启动返回不等于可接收请求，必须等待真实健康接口，避免首个测试撞上导入期。
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit("宠物后端启动失败，请查看 .runtime/backend.log")
        try:
            if httpx.get("http://127.0.0.1:8797/api/health", timeout=1, trust_env=False).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(.2)
    else:
        raise SystemExit("宠物后端启动超时，请查看 .runtime/backend.log")
    print(f"宠物后端已启动：PID {process.pid}，http://127.0.0.1:8797，密钥未写入文件")


if __name__ == "__main__":
    main()
