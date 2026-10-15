"""真实端到端验证：不替换模型、记忆、向量化或召回实现。

只向专用宠物用户写入明确标注的联调数据，不访问其他用户，不删已有记忆。
运行：python tests/live_chain.py。结果落在 docs/日期/熊猫宠物/真实链路结果.json。
"""
from datetime import datetime
import json
import os
from pathlib import Path
import time
import uuid

import httpx


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "docs" / datetime.now().strftime("%Y-%m-%d") / "账号密码登录" / "真实链路结果.json"


def main():
    username, password = os.environ.get("PET_TEST_USERNAME"), os.environ.get("PET_TEST_PASSWORD")
    if not username or not password:
        raise SystemExit("请在运行环境中提供专用测试账号 PET_TEST_USERNAME 与 PET_TEST_PASSWORD；不要使用真实用户账号进行写入测试")
    evidence = {"started_at": datetime.now().isoformat(), "backend": "http://127.0.0.1:8797", "steps": [], "result": "running"}
    with httpx.Client(base_url=evidence["backend"], timeout=180, trust_env=False) as client:
        def call(method, path, **kwargs):
            before = time.monotonic()
            response = client.request(method, path, **kwargs)
            body = response.json()
            evidence["steps"].append({"method": method, "path": path, "status": response.status_code, "seconds": round(time.monotonic() - before, 3), "response": {"code": body.get("code"), "message": body.get("message")} if path.startswith("/api/auth/") else body})
            if response.status_code >= 400 or body["code"] != 0:
                raise AssertionError(f"真实请求失败：{path}；{body.get('message')}")
            return body["data"]

        try:
            auth = call("POST", "/api/auth/login", json={"username": username, "password": password})
            client.headers["X-CSRF-Token"] = auth["csrf_token"]
            call("POST", "/api/connection", json={})
            session = call("POST", "/api/sessions", json={"mode": "training", "title": "真实训练召回与动作联调"})
            path = "/api/sessions/" + session["id"]
            training_text = "我是这次熊猫宠物的联调用户。我疲惫的时候，希望你先安慰我，不要马上给建议。我喜欢听雨声。请把这两个偏好作为训练候选。"
            request_id = str(uuid.uuid4())
            training = call("POST", path + "/chat", json={"content": training_text, "request_id": request_id})
            candidates = training["assistant_message"]["candidates"]
            assert len(candidates) >= 2, "真实模型没有提取两个训练偏好"
            assert all(item["status"] == "pending" for item in candidates), "未确认候选不应伪装已存记忆"
            replay = call("POST", path + "/chat", json={"content": training_text, "request_id": request_id})
            assert replay == training, "对话重放应该幂等"
            confirmed = []
            for candidate in candidates:
                result = call("POST", path + "/memories/confirm", json={"candidate_id": candidate["id"]})
                assert result["status"] == "confirmed" and result["memory_ids"], "没有真实 MemoryOS ID，不能声称已确认"
                confirmed.extend(result["memory_ids"])
            # 同一确认二次调用不能在远端产生第二份业务写入。
            replay_confirm = call("POST", path + "/memories/confirm", json={"candidate_id": candidates[0]["id"]})
            assert replay_confirm["memory_ids"], "确认重放丢失远端 ID"
            memories = call("GET", path + "/memories")
            assert memories["total"] >= 2 and any("雨" in item["content"] for item in memories["items"]), "真实清单缺少已存偏好"
            call("PATCH", path, json={"mode": "chat"})
            answer = call("POST", path + "/chat", json={"content": "你还记得我喜欢听什么声音吗？顺便向我挥挥手，然后眨眨眼。", "request_id": str(uuid.uuid4())})
            assistant = answer["assistant_message"]
            assert "雨" in assistant["content"] and assistant["memories"], "正式对话必须引用真实召回结果"
            explicit = {a["name"] for a in assistant["actions"] if a["trigger"] == "explicit"}
            assert {"wave", "blink"} <= explicit, "用户明确说的两种动作没有输出"
            another = call("POST", "/api/sessions", json={"mode": "chat", "title": "跨会话长期记忆联调"})
            cross = call("POST", "/api/sessions/" + another["id"] + "/chat", json={"content": "我喜欢听什么声音？", "request_id": str(uuid.uuid4())})
            assert "雨" in cross["assistant_message"]["content"] and cross["assistant_message"]["memories"], "跨会话记忆没有从 MemoryOS 召回"
            denied = call("POST", path + "/chat", json={"content": "不要挥手，也不要眨眼，只安静陪着我。", "request_id": str(uuid.uuid4())})
            assert not {"wave", "blink"} & {a["name"] for a in denied["assistant_message"]["actions"]}, "否定动作被执行"
            evidence["confirmed_memory_ids"] = confirmed
            evidence["training_session_id"] = session["id"]
            evidence["result"] = "passed"
        except Exception as exc:
            evidence["result"] = "failed"
            evidence["failure"] = str(exc)
            raise
        finally:
            evidence["finished_at"] = datetime.now().isoformat()
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            REPORT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
            print("真实链路验证：" + evidence["result"] + "；报告：" + str(REPORT))


if __name__ == "__main__":
    main()
