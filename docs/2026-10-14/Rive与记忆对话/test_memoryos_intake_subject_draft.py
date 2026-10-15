"""只读审阅草案：隔离执行实际核心门控，补丁只应用到内存中的源码。"""
import ast
import os
from pathlib import Path
import re
import pytest


CORE = Path("/Users/shuque01/Desktop/project/memoryos/backend/core/retrieval_service.py")
PATCH = Path(__file__).with_name("MemoryOS饮食主语最小修复.patch")
TARGET_ASSIGNMENTS = {
    "_INTAKE_SUBJECT_STOP", "_OTHER_INTAKE_SUBJECT_RE",
    "_OTHER_LIKED_DRINK_RE", "_SELF_INTAKE_QUERY_RE",
}
TARGET_FUNCTIONS = {
    "other_person_intake_name", "self_intake_query", "excludes_other_person_intake",
}


def apply_review_patch(source):
    """核对审阅补丁的逐行替换，不写入核心路径。"""
    replacements = []
    removed = []
    added = []
    for line in PATCH.read_text().splitlines():
        if line.startswith(("---", "+++")):
            continue
        if line.startswith("-"):
            removed.append(line[1:])
        elif line.startswith("+"):
            added.append(line[1:])
        elif removed or added:
            replacements.append((removed, added))
            removed, added = [], []
    if removed or added:
        replacements.append((removed, added))
    for old, new in replacements:
        old_text, new_text = "\n".join(old), "\n".join(new)
        assert old_text in source, "核心版本已变化，必须重新审阅补丁"
        source = source.replace(old_text, new_text, 1)
    return source


@pytest.fixture(scope="module")
def gate():
    source = CORE.read_text()
    variant = os.environ.get("MEMORYOS_DIAG_VARIANT", "original")
    assert variant in {"original", "patched"}
    if variant == "patched":
        source = apply_review_patch(source)
    parsed = ast.parse(source)
    # 仅加载本次门控的原始定义，不初始化DB、模型或服务，避免诊断副作用。
    nodes = [node for node in parsed.body if
             isinstance(node, ast.Assign) and any(
                 isinstance(target, ast.Name) and target.id in TARGET_ASSIGNMENTS
                 for target in node.targets)
             or isinstance(node, ast.FunctionDef) and node.name in TARGET_FUNCTIONS]
    assert len(nodes) == 7
    namespace = {"re": re}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(CORE), "exec"), namespace)
    return namespace


@pytest.mark.parametrize("content", [
    "用户最喜欢的测试饮料是青竹薄荷苏打",
    "用户最喜欢喝青竹薄荷苏打",
    "用户最喜欢吃面条",
])
def test_self_favorite_must_not_be_other_person(gate, content):
    assert gate["other_person_intake_name"](content) is None
    assert gate["excludes_other_person_intake"]("我最喜欢的测试饮料是什么？", content) is False


@pytest.mark.parametrize("content, name", [
    ("沈澄喜欢无糖乌龙茶", "沈澄"),
    ("王小明喜欢咖啡", "王小明"),
    ("沈澄最喜欢的饮料是青竹薄荷苏打", "沈澄"),
    ("王小明最喜欢喝咖啡", "王小明"),
    ("角色沈澄现在改喝温白开水", "沈澄"),
])
def test_real_other_person_remains_excluded(gate, content, name):
    assert gate["other_person_intake_name"](content) == name
    assert gate["excludes_other_person_intake"]("我最喜欢什么饮料？", content) is True


@pytest.mark.parametrize("content", [
    "用户喜欢无糖乌龙茶", "本人喜欢咖啡", "我喜欢喝牛奶", "常用饮料不再是拿铁",
])
def test_existing_self_subjects_remain_eligible(gate, content):
    assert gate["excludes_other_person_intake"]("我最喜欢什么饮料？", content) is False


def test_explicit_person_named_in_query_not_excluded(gate):
    assert gate["excludes_other_person_intake"](
        "我记得沈澄最喜欢的饮料是什么？", "沈澄最喜欢的饮料是咖啡") is False


def test_non_intake_query_unchanged(gate):
    assert gate["excludes_other_person_intake"](
        "青竹薄荷苏打", "用户最喜欢的测试饮料是青竹薄荷苏打") is False
