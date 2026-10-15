# 饮食主语识别：待授权审阅方案

## 拟改文件与最小变化

拟修改 MemoryOS 的 `backend/core/retrieval_service.py`，仅调整 `_OTHER_INTAKE_SUBJECT_RE` 与 `_OTHER_LIKED_DRINK_RE` 的四行模式：姓名捕获由贪婪 2～3 字改为非贪婪 2～3 字，姓名后明确允许程度词“最”再接“喜欢”。两个饮食模式共用同一主语判定，均需调整，否则“用户最喜欢喝……”仍会通过另一模式误杀。

“用户最喜欢……”先捕获“用户”，后将“最”归到谓语，已有停用词集合自然拒绝将“用户”当姓名。三字真实姓名如“王小明最喜欢喝咖啡”仍完整捕获“王小明”并保留第三方过滤。没有改写用户 query 或候选内容，没有关闭主语门控。

可审阅补丁为 `MemoryOS饮食主语最小修复.patch`。已执行只读 `git apply --check`，能应用于当前 MemoryOS 版本，但未实际应用；未编辑核心文件，未改数据库、配置或凭据，未重启。

## 影响范围与限制

该门控位于共享 `RetrievalService` 的候选评分流程，修改会影响使用此服务的 `/recall`、普通对话、宠物对话等召回调用。只改变含“最喜欢”的饮食句主语边界；租户、隐私、来源证据、生命周期、时间门控、候选召回、模型和排序流程保持原实现。

风险来自中文姓名与程度词的天然边界歧义。此次补丁仍沿用既有 2～3 字姓名识别启发式，没有扩展到全面中文姓名识别。审阅测试覆盖典型两字/三字姓名及既有本人短语，但不能证明所有开放域中文句式正确。核心最终实施前应补充现有召回回归，实施后仍需原真实 HTTP 复现由红转绿；隔离函数测试成功不等同于真实服务已修复。

## 回归草案与执行结果

草案 `test_memoryos_intake_subject_draft.py` 从当前真实核心文件 AST 提取四个正则/停用词定义与三个实际函数。原版直接执行这些定义；修复版把审阅 patch 应用到内存源码后执行同一组函数。无模型或数据库初始化，不写入核心文件。

```bash
# 只读原版，预期暴露缺陷
MEMORYOS_DIAG_VARIANT=original /opt/anaconda3/envs/xyd/bin/python -m pytest docs/2026-10-14/Rive与记忆对话/test_memoryos_intake_subject_draft.py -q --tb=short
# 内存隔离修复，预期全部通过
MEMORYOS_DIAG_VARIANT=patched /opt/anaconda3/envs/xyd/bin/python -m pytest docs/2026-10-14/Rive与记忆对话/test_memoryos_intake_subject_draft.py -q --tb=short
```

执行目录为独立项目 `/Volumes/ORICO/project/memory-pet`。原版实测 5 失败、9 通过；内存补丁实测 14 通过。失败包括三条“用户最喜欢”的误识别、两字姓名把“最”吞入名字、三字姓名接“最喜欢喝”未识别。绿版保留真实第三方排除，覆盖显式点名查询、本人既有表达和非饮食查询不受影响。

此方案需要用户确认后才能应用到 MemoryOS 核心；诊断阶段至此交付可审阅结果。原问题真实 HTTP 复现仍为红，未宣称修复或伪造召回成功。
