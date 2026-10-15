"""会话编排：召回、模型计算、落库阶段明确分离。"""
import asyncio
import hashlib
import uuid

from .actions import resolve_actions
from .errors import ServiceError
from .database import run_db
from .store import now


class PetService:
    def __init__(self, store, providers):
        self.store, self.providers = store, providers
        self.locks = {}

    def lock(self, key):
        return self.locks.setdefault(key, asyncio.Lock())

    @staticmethod
    def candidate_public(candidate):
        return {k: candidate[k] for k in ("id", "content", "status", "memory_ids")}

    async def begin_operation(self, key, session_id, fingerprint, **kwargs):
        # 取消发生在短事务提交瞬间时，先确认是否成功占有请求，再清理本请求状态。
        pending = asyncio.create_task(run_db(self.store.begin_operation, key, session_id, fingerprint, **kwargs))
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            result = (await asyncio.gather(pending, return_exceptions=True))[0]
            if result is None:
                await run_db(self.store.fail_operation, key)
            raise

    async def chat(self, c, session_id, body, on_delta=None):
        c.ready()
        key = f"{session_id}:{body.request_id}"
        # 同一会话按顺序处理，避免并发回复丢失上一轮上下文。
        async with self.lock(f"session:{session_id}"):
            session = await run_db(self.store.session, session_id, c.scope)
            surface = session["surface"]
            fingerprint = hashlib.sha256(f"{surface}:{session['mode']}:{body.pet_name}:{body.content}".encode()).hexdigest()
            # 旧宠物请求的指纹未含surface，只在pet读取时兼容，普通页面不能复用。
            legacy = hashlib.sha256(f"{session['mode']}:{body.pet_name}:{body.content}".encode()).hexdigest() if surface == "pet" else None
            previous = await self.begin_operation(key, session_id, fingerprint, legacy_fingerprint=legacy)
            if previous is not None:
                # 重放时展示候选的最新状态，避免已确认候选变回待确认。
                ids = [r["id"] for r in previous["assistant_message"]["candidates"]]
                candidates = await run_db(self.store.candidates_by_ids, session_id, c.scope, ids)
                previous["assistant_message"]["candidates"] = [self.candidate_public(candidates[cid]) for cid in ids]
                if on_delta is not None:
                    await on_delta(previous["assistant_message"]["content"])
                return previous
            try:
                history = await run_db(self.store.history, session_id, c.scope)
                remote_request_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"memory-pet:{session_id}:{body.request_id}"))
                memories = await self.providers.recall(c, body.content, session_id, remote_request_id)
                output = await self.providers.reply(c, session["mode"], body.content, history, memories, body.pet_name, surface, **({"on_delta": on_delta} if on_delta is not None else {}))
                user = {"id": str(uuid.uuid4()), "role": "user", "content": body.content, "emotion": "neutral", "actions": [], "memories": [], "candidates": [], "created_at": now()}
                assistant = {"id": str(uuid.uuid4()), "role": "assistant", "content": output.reply, "emotion": output.emotion, "actions": resolve_actions(body.content, output) if surface == "pet" else [], "memories": memories, "candidates": [{"id": str(uuid.uuid4()), "content": text, "status": "pending", "memory_ids": []} for text in output.candidates], "created_at": now()}
                # 随消息 JSON 保存已解析的称呼，前端重试和历史读取复用同一结果；不新增记忆写入。
                if surface == "pet" and output.pet_name:
                    assistant["pet_name"] = output.pet_name
                result = {"user_message": user, "assistant_message": assistant}
                await run_db(self.store.complete_chat, key, session_id, result)
                return result
            except BaseException:
                # 取消也恢复到可重试状态；此处没有打开的数据库或模型事务。
                await run_db(self.store.fail_operation, key)
                raise

    async def edit_candidate(self, c, session_id, candidate_id, body):
        async with self.lock(f"candidate:{candidate_id}"):
            candidate = await run_db(self.store.candidate, session_id, c.scope, candidate_id)
            if candidate["status"] != "pending":
                raise ServiceError("只能修改或拒绝待确认的训练候选", 409)
            if await run_db(self.store.confirmation_state, candidate_id) in {"running", "failed"}:
                raise ServiceError("上次记忆写入结果尚未确定，请先按原内容重试确认，再进行调整", 409)
            if body.content is None and body.status is None:
                raise ServiceError("请填写修正内容或选择拒绝")
            if body.content is not None and not body.content.strip():
                raise ServiceError("训练内容不能为空")
            await run_db(self.store.update_candidate, candidate_id, content=body.content.strip() if body.content is not None else None, status=body.status)
            return self.candidate_public(await run_db(self.store.candidate, session_id, c.scope, candidate_id))

    async def confirm(self, c, session_id, candidate_id):
        c.ready()
        async with self.lock(f"candidate:{candidate_id}"):
            session = await run_db(self.store.session, session_id, c.scope)
            candidate = await run_db(self.store.candidate, session_id, c.scope, candidate_id)
            if candidate["status"] == "confirmed":
                return self.candidate_public(candidate)
            if candidate["status"] == "rejected":
                raise ServiceError("已拒绝的训练候选不能确认", 409)
            # 固定修订版本的 source_id：超时或进程中断后按原内容重试，不重复生成记忆。
            key = f"confirm:{candidate_id}"
            fingerprint = hashlib.sha256(candidate["content"].encode()).hexdigest()
            await self.begin_operation(key, session_id, fingerprint)
            try:
                if session["surface"] == "memory":
                    ids = await self.providers.ingest(c, candidate, source="记忆对话测试")
                else:
                    ids = await self.providers.ingest(c, candidate)
                result = {**self.candidate_public(candidate), "status": "confirmed", "memory_ids": ids}
                await run_db(self.store.complete_confirmation, candidate_id, ids, result)
                return result
            except ServiceError as exc:
                # 明确未生成任何记忆才允许修改候选，其余结果不确定时先幂等重试。
                await run_db(self.store.fail_operation, key, state="editable" if exc.status == 422 else "failed")
                raise
            except BaseException:
                await run_db(self.store.fail_operation, key)
                raise
