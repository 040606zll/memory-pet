"""真实供应商差分复现；凭据只读且不输出、不写结果，模型每个对比只调用一次。

仅使用指定宠物本地会话的最近20条消息和已记录的专用测试偏好。
构造阶段的样本仅用于复用Providers请求构造，绝不作为模型通过证据。
"""
import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import sys
import time

from dotenv import dotenv_values
import httpx

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT / "backend"))
from pet.config import Connection
from pet.database import DatabaseConfig
from pet.settings import load_settings
from pet.store import Store
from pet.providers import Providers
from pet.schemas import ModelOutput

MESSAGE = "不要挥手，也不要眨眼，只安静陪着我。"
REPORT = ROOT / "docs/2026-10-14/熊猫宠物/模型JSON模式真实对比.json"


async def main(args):
    values = dotenv_values(Path(args.memoryos_project) / ".env")
    config = Connection(llm_url=values["LLM_BASE_URL"], llm_key=values["LLM_API_KEY"], model=values["LLM_MODEL"])
    store = Store(DatabaseConfig.from_settings(load_settings()))
    # 差分脚本只读已有 MySQL 消息，不初始化、不迁移数据库。
    try:
        with store.db() as db:
            rows = db.execute("SELECT body FROM messages WHERE session_id=%s ORDER BY created_at DESC LIMIT 20", (args.session,)).fetchall()
        history = [{"role": b["role"], "content": b["content"]} for b in (json.loads(row["body"]) for row in reversed(rows))]
    finally:
        store.close()
    # 专用测试用户的实际已确认偏好；不用本地内容冒充长期召回链路。
    live = json.loads((ROOT / "docs/2026-10-14/熊猫宠物/真实链路结果.json").read_text())
    remote_memory = next(step["response"]["data"]["items"] for step in live["steps"] if step["path"].endswith("/memories") and step["method"] == "GET")
    payload = None

    def capture(request):
        nonlocal payload
        payload = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": '{"reply":"仅构造请求样本，不作为模型证据"}'}, "finish_reason": "stop"}]})

    # 运行真实 Agent，仅在传输层捕获请求；此步骤不会访问外网或计为模型验证。
    async with httpx.AsyncClient(transport=httpx.MockTransport(capture), trust_env=False) as client:
        await Providers(client).reply(config, "chat", MESSAGE, history, remote_memory)
    if args.baseline:
        # 精确回放修复前的wire内容，便于未来继续比较供应商行为。
        payload["messages"][-1]["content"] = MESSAGE
    if args.system_layout == "merged":
        messages = payload["messages"]
        payload["messages"] = [{"role": "system", "content": messages[0]["content"] + "\n\n" + messages[1]["content"]}, *messages[2:]]
    if args.user_json_hint:
        payload["messages"][-1]["content"] = "请依据以下用户消息生成完整 json 对象，包含 reply、emotion、actions、candidates 四个字段。用户消息：\n" + payload["messages"][-1]["content"]
    evidence = {"baseline": args.baseline, "after_fix": args.after_fix, "user_json_hint": args.user_json_hint, "system_layout": args.system_layout, "started_at": datetime.now().isoformat(), "model": config.model, "session_id": args.session, "message": MESSAGE, "history_count": len(history), "memories_count": len(remote_memory), "attempts": []}
    report = REPORT if args.system_layout == "separate" else REPORT.with_name("模型JSON单system真实对比.json")
    if args.user_json_hint:
        report = REPORT.with_name("模型JSON用户层结构提醒真实对比.json")
    if args.after_fix or not args.baseline:
        report = REPORT.with_name("模型JSON修复后真实回归.json")
    report.parent.mkdir(parents=True, exist_ok=True)
    endpoint = config.llm_url.rstrip("/") + "/chat/completions"
    async with httpx.AsyncClient(timeout=90, trust_env=False) as client:
        for mode in args.modes.split(","):
            for repeat in range(args.repeat):
                body = dict(payload)
                if mode == "prompt_json":
                    body.pop("response_format", None)
                before = time.monotonic()
                response = await client.post(endpoint, headers={"Authorization": "Bearer " + config.llm_key}, json=body)
                result = response.json()
                choice = result.get("choices", [{}])[0]
                raw = choice.get("message", {}).get("content")
                valid, parsed = False, None
                try:
                    parsed = ModelOutput.from_model(json.loads(raw))
                    valid = bool(parsed.reply.strip()) and choice.get("finish_reason") not in {"length", "content_filter"}
                except (TypeError, ValueError):
                    pass
                # 结果无Headers/Key；加二次精确擦除，避免供应商异常回显秘密。
                safe_raw = raw.replace(config.llm_key, "<REDACTED>") if isinstance(raw, str) else None
                row = {"mode": mode, "repeat": repeat + 1, "status": response.status_code, "seconds": round(time.monotonic() - before, 3), "finish_reason": choice.get("finish_reason"), "content_chars": len(raw) if isinstance(raw, str) else None, "nonblank_chars": len(raw.strip()) if isinstance(raw, str) else None, "valid_reply": valid, "content": safe_raw}
                evidence["attempts"].append(row)
                report.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
                print(json.dumps({k: v for k, v in row.items() if k != "content"}, ensure_ascii=False), flush=True)
    evidence["finished_at"] = datetime.now().isoformat()
    report.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    if args.assert_valid and not all(row["valid_reply"] for row in evidence["attempts"]):
        raise SystemExit("复现失败信号：至少一次真实模型返回非有效JSON正文")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--memoryos-project", default="/Users/shuque01/Desktop/project/memoryos")
    parser.add_argument("--session", default="3d71dd4e-d373-4dc2-b969-d931a46521d3")
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--after-fix", action="store_true")
    parser.add_argument("--user-json-hint", action="store_true")
    parser.add_argument("--system-layout", choices=["separate", "merged"], default="separate")
    parser.add_argument("--modes", default="json_object,prompt_json")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--assert-valid", action="store_true")
    asyncio.run(main(parser.parse_args()))
