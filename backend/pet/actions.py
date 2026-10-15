"""中文动作命令识别：明确请求优先，否定指令禁止同名动作。"""
import re

ALIASES = {
    "blink": ["眨眼", "眨眨眼", "眼睛眨", "眨一眨", "眨一下", "眨眨"],
    "wave": ["挥手", "挥挥手", "招手", "挥一下手", "挥爪", "挥挥爪", "挥一下爪"],
    "nod": ["点头", "点点头", "点一下头"],
    "shake_head": ["摇头", "摇摇头", "摇一下头"],
    "stretch": ["伸懒腰", "伸个懒腰", "伸一下懒腰"],
    "happy": ["开心一下", "笑一笑", "微笑一下"],
    "sleep": ["睡觉", "睡一会", "睡一觉", "打盹"],
    "wag_tail": ["摇尾巴", "摇摇尾巴", "摇一下尾巴", "摇一摇尾巴", "摇尾", "摆尾"],
}
NEGATION = re.compile(r"(?:不要|别|不许|不能|禁止|不用|不想|无需|别再|不必|别给我).{0,8}$")
PAST = re.compile(r"(?:昨天|刚才|之前|曾经|看到|看见|他说|她说).{0,8}$")
DURATIONS = {"blink": 900, "wave": 1800, "nod": 1200, "shake_head": 1400, "stretch": 2600, "happy": 2300, "sleep": 5000, "wag_tail": 2200}


def _parse_commands(content: str):
    explicit, forbidden, historical = [], set(), set()
    for name, aliases in ALIASES.items():
        for alias in aliases:
            for match in re.finditer(re.escape(alias), content):
                prefix = re.split(r"[，。！？;；\n]", content[:match.start()])[-1]
                if NEGATION.search(prefix):
                    forbidden.add(name)
                elif PAST.search(prefix):
                    historical.add(name)
                else:
                    explicit.append((match.start(), name))
    return list(dict.fromkeys(n for _, n in sorted(explicit) if n not in forbidden)), forbidden, historical


def commands(content: str):
    explicit, forbidden, _ = _parse_commands(content)
    return explicit, forbidden


def resolve_actions(content, output):
    explicit, forbidden, historical = _parse_commands(content)
    # 仅过去叙述的动作不能被模型重新当作情绪动作；同条消息的新请求优先。
    forbidden |= historical.difference(explicit)
    names, trigger = (explicit, "explicit") if explicit else (output.actions, "emotion")
    if not names and not explicit:
        names = {"happy": ["happy"], "excited": ["wave"], "sad": ["nod"], "sleepy": ["sleep"], "curious": ["blink"]}.get(output.emotion, [])
    return [{"name": n, "trigger": trigger, "duration_ms": DURATIONS[n]} for n in list(dict.fromkeys(names))[:3] if n not in forbidden]
