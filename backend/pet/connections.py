"""连接验证及 API Key 到远端用户的固定绑定，不保存明文 Key。"""
from dataclasses import replace
from sqlalchemy.exc import IntegrityError
import uuid

from .errors import ServiceError
from .database import run_db

USER_LABEL = "MemoryPet 专属用户"


def user_record(row, *, require_active=True):
    try:
        user_id = str(uuid.UUID(row["id"]))
        key_id = str(uuid.UUID(row["api_key_id"]))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise ServiceError("记忆服务未返回有效的用户与 API Key 归属信息", 502) from None
    if require_active and row.get("status") != "active":
        raise ServiceError("绑定的记忆用户已停用，请联系管理员处理", 409)
    return user_id, key_id


class Connections:
    def __init__(self, store, providers):
        self.store, self.providers = store, providers

    async def directory(self, c, **filters):
        result = await self.providers.memory(c, "GET", "/users", params={"limit": 2, "offset": 0, **filters})
        if not isinstance(result, dict) or not isinstance(result.get("items"), list) or type(result.get("total")) is not int:
            raise ServiceError("记忆服务用户目录格式无效", 502)
        rows, total = result["items"], result["total"]
        if total < 0 or len(rows) != min(total, 2):
            raise ServiceError("记忆服务用户目录数量不一致", 502)
        return rows, total

    def binding(self, service_url, key_id):
        with self.store.db() as db:
            row = db.execute("SELECT user_id FROM memory_user_bindings WHERE service_url=%s AND api_key_id=%s", (service_url, key_id)).fetchone()
        return row["user_id"] if row else None

    def bind(self, c, key_id):
        # 网络调用全部结束后才开启短事务，唯一约束确保一对一且禁止静默换绑。
        try:
            with self.store.db() as db:
                db.execute("INSERT INTO memory_user_bindings(service_url,service_hash,api_key_id,user_id) VALUES(%s,UNHEX(SHA2(%s,256)),%s,%s) ON DUPLICATE KEY UPDATE api_key_id=api_key_id", (c.memory_url, c.memory_url, key_id, c.user_id))
                actual = db.execute("SELECT user_id FROM memory_user_bindings WHERE service_url=%s AND api_key_id=%s", (c.memory_url, key_id)).fetchone()
                if actual["user_id"] != c.user_id:
                    raise ServiceError("该 API Key 已绑定其他用户，不能更换记忆归属", 409)
        except IntegrityError:
            raise ServiceError("该记忆用户已有其他 API Key 绑定，请联系管理员处理", 409) from None

    async def validate(self, c):
        if not c.memory_key:
            raise ServiceError("请先填写记忆服务 API Key", 428)
        c.model_ready()
        await self.providers.check_ready(c)
        # 按部署要求不探测匿名目录；后续请求仍携带 Key，并核验用户归属和固定绑定。
        rows, total = await self.directory(c)
        key_id, chosen = None, None
        if rows:
            first_id, key_id = user_record(rows[0], require_active=False)
            chosen = await run_db(self.binding, c.memory_url, key_id)
            if chosen and c.user_id and chosen != c.user_id:
                raise ServiceError("该 API Key 已绑定其他用户，不能更换记忆归属", 409)
            chosen = chosen or c.user_id or (first_id if total == 1 else None)
            if not chosen:
                # 多用户 Key 无本地绑定时，恢复创建后响应丢失的专属用户，不能盲目重建。
                matches, count = await self.directory(c, search=USER_LABEL)
                exact = [row for row in matches if row.get("display_name") == USER_LABEL]
                if count > 1 or len(exact) != count:
                    raise ServiceError("该 API Key 下有多个专属用户，请管理员固定用户 ID 后连接", 409)
                if exact:
                    chosen, owner = user_record(exact[0])
                    if owner != key_id:
                        raise ServiceError("记忆服务返回了不属于当前 API Key 的用户", 502)
        elif c.user_id:
            # 已配置的固定用户不能在丢失后悄悄换成新用户。
            raise ServiceError("固定用户不在当前 API Key 名下，请检查后端用户配置", 409)
        if chosen:
            row = await self.providers.memory(c, "GET", f"/users/{chosen}")
            actual, owner = user_record(row)
            if actual != chosen or owner != key_id:
                raise ServiceError("记忆用户与当前 API Key 不对应，请检查用户归属", 409)
        # 先验证模型，避免模型配置错误时创建无用的远端用户。
        await self.providers.reply(c, "chat", "你好，回复一句简短问候。", [], [])
        if not chosen:
            row = await self.providers.memory(c, "POST", "/users", json={"display_name": USER_LABEL, "kb_enabled": False})
            chosen, owner = user_record(row)
            if key_id and owner != key_id:
                raise ServiceError("新用户不属于当前 API Key，已停止连接", 502)
            key_id = owner
        c = replace(c, user_id=chosen)
        await self.providers.check_user(c)
        await run_db(self.bind, c, key_id)
        return c


class AccountConnections:
    """按本地账号创建远端用户，不从全局目录选择旧用户或继承全局 UUID。"""

    def __init__(self, accounts, providers):
        self.accounts, self.providers = accounts, providers

    @staticmethod
    def record(row):
        try:
            return user_record(row)
        except ServiceError as exc:
            if exc.status == 502:
                raise ServiceError("记忆服务未能确认账号归属，请联系管理员检查服务配置", 502) from None
            raise

    async def call(self, c, method, path, **kwargs):
        try:
            return await self.providers.memory(c, method, path, **kwargs)
        except ServiceError as exc:
            if "鉴权失败" in exc.message:
                raise ServiceError("记忆服务的服务端凭据无效或权限不足，请联系管理员处理", 503) from None
            raise

    async def resolve(self, base, account_id):
        if not base.memory_key:
            raise ServiceError("管理员尚未配置记忆服务凭据，请联系管理员处理", 503)
        c = replace(base, user_id="", local_account_id=account_id)
        ready = await self.call(c, "GET", "/health/ready")
        if not isinstance(ready, dict) or ready.get("status") != "ready":
            raise ServiceError("记忆服务暂未就绪，请稍后重试", 503)
        # profile 是部署策略，不代替身份验证；本地 simple 模式同样检查真实用户归属和权限。
        binding = await run_db(self.accounts.binding, account_id, c.memory_url)
        if binding and binding["memory_user_id"]:
            chosen = binding["memory_user_id"]
            row = await self.call(c, "GET", f"/users/{chosen}")
            actual, key_id = self.record(row)
            if actual != chosen or key_id != binding["api_key_id"]:
                raise ServiceError("记忆账号归属发生变化，请联系管理员处理", 409)
            c = replace(c, user_id=chosen)
            await self.providers.check_user(c)
            return c
        # 租约跨进程防重入；网络阶段不持有 SQLite 连接或数据库锁。
        owner = str(uuid.uuid4())
        try:
            # 先确定租约标识，取消时即使数据库已提交也能在 finally 精确释放。
            await run_db(self.accounts.claim, account_id, c.memory_url, owner)
            label = f"MemoryPet:{account_id}"
            result = await self.call(c, "GET", "/users", params={"search": label, "limit": 2, "offset": 0})
            if not isinstance(result, dict) or not isinstance(result.get("items"), list) or type(result.get("total")) is not int:
                raise ServiceError("记忆服务用户信息格式无效，请联系管理员处理", 502)
            rows, total = result["items"], result["total"]
            if total not in (0, 1) or len(rows) != total or any(not isinstance(row, dict) or row.get("display_name") != label for row in rows):
                raise ServiceError("记忆账号映射存在歧义，请联系管理员处理", 409)
            # 响应丢失后的重试按稳定标记找回，不能再次无条件创建远端用户。
            row = rows[0] if rows else await self.call(c, "POST", "/users", json={"display_name": label, "kb_enabled": False})
            chosen, key_id = self.record(row)
            c = replace(c, user_id=chosen)
            await self.providers.check_user(c)
            await run_db(self.accounts.bind, account_id, c.memory_url, owner, chosen, key_id)
            return c
        finally:
            await run_db(self.accounts.release, account_id, c.memory_url, owner)
