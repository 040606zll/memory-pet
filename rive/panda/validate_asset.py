"""校验纯矢量 Rive 素材契约和官方 CLI 的真实渲染结果，不编辑图片。"""
from pathlib import Path
import json
import subprocess
import hashlib
import xml.etree.ElementTree as ET
from collections import Counter

PROJECT = Path(__file__).resolve().parent
ROOT = PROJECT.parents[1]
CLI = ROOT / ".runtime/tools/rive/bin/rive"
SOURCE = ET.parse(PROJECT / "scene.rml").getroot()
CHECKS = []


def check(name, condition, detail):
    CHECKS.append({"name": name, "passed": bool(condition), "detail": detail})


def command(*arguments):
    result = subprocess.run([str(CLI), *map(str, arguments)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result


verified = command(PROJECT, "--verify", "--format=json")
check("官方编译", '\"success\": true' in verified.stdout and '\"problems\": []' in verified.stdout,
      "--verify --format=json 返回成功，无错误或警告")
resolved = json.loads(command("inspect", PROJECT, "--json").stdout)
check("官方结构检查", resolved["problems"] == [], "inspect problems 为空")
counts = Counter(element.tag for element in SOURCE.iter())
check("纯矢量素材", not any("Image" in kind or "Script" in kind or "Asset" in kind for kind in counts),
      "没有图片资产、脚本或图集对象")
check("独立部件", counts["Shape"] >= 60 and counts["Node"] >= 10,
      f"{counts['Shape']} 个矢量 Shape，{counts['Node']} 个 Node")
animations = {item.get("name"): item for item in SOURCE.iter("LinearAnimation")}
expected = {"breathing": 240, "idle": 240, "blink": 33, "wave": 108, "nod": 75,
            "shake_head": 90, "stretch": 168, "happy": 114, "sleep": 240}
check("全部时间线", set(animations) == set(expected) and all(int(animations[k].get("duration")) == v for k, v in expected.items()),
      "八动作加常驻呼吸，60fps 和约定时长一致")
for name in expected:
    properties = list(animations[name].iter("KeyedProperty"))
    changing = [p for p in properties if len({f.get("value") for f in p}) > 1]
    check(f"{name} 连续关键帧", bool(changing), f"{len(changing)} 条轨道存在不同数值关键帧")
check("ViewModel 契约", SOURCE.find(".//ViewModel").get("name") == "PandaControl" and
      SOURCE.find(".//ViewModelPropertyNumber").get("name") == "action" and
      SOURCE.find(".//ViewModelPropertyTrigger").get("name") == "perform", "action 数字与 perform 触发器")
check("双层状态机", len(SOURCE.findall(".//StateMachineLayer")) == 2 and counts["TransitionViewModelCondition"] == 16,
      "常驻呼吸和动作独立，8 条动作入口均需数字与触发条件")
returns = [t for t in SOURCE.iter("StateTransition") if t.get("enableExitTime") == "true"]
check("自动返回待机", len(returns) == 7 and all(t.get("stateToId") == "0:501" and t.get("duration") == "180" for t in returns),
      "7 个 oneShot 在时间线结束后经 180ms 混合回 idle")
for action, name, frame in [(1,"blink",13),(2,"wave",48),(3,"nod",17),(4,"shake_head",22),(5,"stretch",72),(6,"happy",53),(7,"sleep",100)]:
    path = PROJECT / "build" / f"baseline-{name}.png"
    command(PROJECT, f"--screenshot={path}", f"--advance={frame}", "--viewport=640x700", "--fit=contain")
    active = PROJECT / "build" / f"{name}.png"
    command(PROJECT, f"--screenshot={active}", f"--data=action={action}", "--data=perform=true", f"--advance={frame}", "--viewport=640x700", "--fit=contain")
    digest = lambda target: hashlib.sha256(target.read_bytes()).hexdigest()
    check(f"{name} 运行时触发", active.exists() and digest(active) != digest(path),
          f"action={action} + perform=true 在第 {frame} 帧与相同时间待机渲染不同")
asset = ROOT / "frontend/public/assets/panda.riv"
check("交付二进制", asset.exists() and asset.read_bytes()[:4] == b"RIVE" and asset.stat().st_size > 10000,
      f"RIVE 头部；{asset.stat().st_size} 字节")
report = {"total": len(CHECKS), "passed": sum(c["passed"] for c in CHECKS), "checks": CHECKS}
(PROJECT / "build/asset-test-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(0 if all(c["passed"] for c in CHECKS) else 1)
