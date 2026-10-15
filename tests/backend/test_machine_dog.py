"""机器狗人格、真实动作契约和普通记忆页兼容回归。"""
import pytest

from test_api import world, chat, data, session
from pet.actions import commands, resolve_actions
from pet.schemas import ModelOutput


@pytest.mark.parametrize("content,names", [
    ("请摇摇尾巴", ["wag_tail"]),
    ("摇一摇尾巴，再挥挥爪", ["wag_tail", "wave"]),
    ("不要摇尾巴，请眨眼", ["blink"]),
    ("别摆尾，也不要摇尾巴", []),
    ("昨天你摇尾巴了", []),
    ("他说摇尾巴很好看", []),
    ("昨天你摇尾巴了，现在请摇尾巴", ["wag_tail"]),
    ("刚才你挥手了", []),
])
def test_tail_commands_negation_past_and_current_request(content, names):
    output = ModelOutput(reply="真实模型正文", actions=["wag_tail", "wave"])
    assert commands(content)[0] == names
    actions = resolve_actions(content, output)
    if names:
        assert [a["name"] for a in actions] == names
        assert all(a["trigger"] == "explicit" for a in actions)
        assert all(a["duration_ms"] == 2200 for a in actions if a["name"] == "wag_tail")
    elif "挥手" in content:
        assert "wave" not in [a["name"] for a in actions]
    else:
        assert "wag_tail" not in [a["name"] for a in actions]


def test_tail_model_allowlist_and_emotion_trigger():
    output = ModelOutput.from_model({"reply": "你好", "emotion": "happy", "actions": ["wag_tail", "dance"]})
    assert output.actions == ["wag_tail"]
    assert resolve_actions("你好", output) == [{"name": "wag_tail", "trigger": "emotion", "duration_ms": 2200}]
    # 旧七动作仍校验通过，前爪动作继续使用已有wave协议。
    for name in ["blink", "wave", "nod", "shake_head", "stretch", "happy", "sleep"]:
        assert ModelOutput(reply="好", actions=[name]).actions == [name]


def test_machine_dog_training_confirmation_and_formal_recall(world):
    client, remote, app = world
    remote.reply.update(actions=["wag_tail"])
    sid = session(client)
    assistant = chat(client, sid, "我喜欢喝绿茶，请摇尾巴", "dog-training")["assistant_message"]
    assert assistant["actions"] == [{"name": "wag_tail", "trigger": "explicit", "duration_ms": 2200}]
    assert assistant["candidates"][0]["status"] == "pending" and not remote.saved
    prompt = [r for r in remote.calls if r[1].endswith("chat/completions")][-1][2]["messages"][0]["content"]
    assert "毛绒机器狗宠物" in prompt and "熊猫" not in prompt
    assert "wag_tail=摇尾巴" in prompt and "wave=前爪挥动" in prompt
    assert "等待你确认" in prompt and "不执行引用/过去叙述的动作" in prompt
    cid = assistant["candidates"][0]["id"]
    confirmed = data(client.post(f"/api/sessions/{sid}/memories/confirm", json={"candidate_id": cid}))
    formal = session(client, "chat")
    answer = chat(client, formal, "我喜欢喝什么？昨天你摇尾巴了", "dog-formal")["assistant_message"]
    assert answer["candidates"] == [] and answer["actions"] == []
    assert answer["memories"][0]["id"] in confirmed["memory_ids"]


@pytest.mark.parametrize("mode", ["training", "chat"])
def test_normal_memory_surface_ignores_machine_dog_actions(world, mode):
    client, remote, app = world
    remote.reply.update(actions=["wag_tail", "wave"])
    sid = data(client.post("/api/sessions", json={"surface": "memory", "mode": mode}))["id"]
    result = chat(client, sid, "请摇尾巴，挥挥爪", "normal-tail")["assistant_message"]
    assert result["actions"] == []
    assert not remote.saved
    if mode == "chat":
        assert result["candidates"] == []
    else:
        assert result["candidates"][0]["status"] == "pending"
    prompt = [r for r in remote.calls if r[1].endswith("chat/completions")][-1][2]["messages"][0]["content"]
    assert "普通中文记忆助手" in prompt and "毛绒机器狗" not in prompt
    assert "actions必须始终为空数组" in prompt and "wag_tail" not in prompt
