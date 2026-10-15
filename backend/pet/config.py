"""模型由服务端文件或环境配置；浏览器仅可更新记忆服务连接。"""
from dataclasses import dataclass, replace
import hashlib
from urllib.parse import urlparse
import uuid

from .errors import ServiceError
from .settings import load_settings


def validated_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ServiceError("服务地址必须是完整的 HTTP 或 HTTPS 地址，不能包含账号、查询参数或片段")
    try:
        parsed.port
    except ValueError:
        raise ServiceError("服务地址端口无效，请填写有效端口") from None
    return value.strip().rstrip("/")


def origin(value: str):
    parsed = urlparse(value)
    return (parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))


@dataclass(frozen=True)
class Connection:
    memory_url: str = "http://127.0.0.1:8000"
    memory_key: str = ""
    user_id: str = ""
    llm_url: str = ""
    llm_key: str = ""
    model: str = ""
    local_account_id: str = ""

    @classmethod
    def environment(cls, settings=None):
        values = load_settings() if settings is None else settings
        memory_url = validated_url(values.get("MEMORYOS_BASE_URL", "http://127.0.0.1:8000"))
        llm_url = values.get("LLM_BASE_URL", "")
        return cls(memory_url, values.get("MEMORYOS_API_KEY", ""), values.get("MEMORYOS_USER_ID", ""), validated_url(llm_url) if llm_url else "", values.get("LLM_API_KEY", ""), values.get("LLM_MODEL", ""))

    @property
    def scope(self):
        if self.local_account_id:
            # 新账号历史按本地身份隔离；禁止自动认领旧全局连接的历史。
            return hashlib.sha256(f"account:{self.local_account_id}|{self.memory_url}".encode()).hexdigest()
        # 上游用户 UUID 全局唯一；接口访问前真实验证 key，正常轮换不丢失历史。
        return hashlib.sha256(f"{self.memory_url}|{self.user_id}".encode()).hexdigest()

    def public(self):
        return {"memoryos": {"base_url": self.memory_url, "user_id": self.user_id, "configured": bool(self.memory_key and self.user_id)}, "llm": {"configured": bool(self.llm_url and self.llm_key and self.model)}}

    def ready(self):
        if not self.user_id or not self.memory_key:
            raise ServiceError("账号的记忆服务尚未连接，请重试或联系管理员", 503)
        self.model_ready()

    def model_ready(self):
        if not self.llm_url or not self.llm_key or not self.model:
            raise ServiceError("宠物后端尚未配置完整的大模型服务，请联系管理员配置后重启宠物后端", 428)

    def update(self, body):
        memory_url = validated_url(body.memoryos.base_url)
        memory_key = (body.memoryos.api_key or "").strip()
        # 改 host/协议/端口后不能继承旧秘密，避免验证请求误把 Key 发到另一个服务。
        if self.memory_key and origin(memory_url) != origin(self.memory_url) and not memory_key:
            raise ServiceError("记忆服务地址已更换，请重新填写该服务的 API Key", 422)
        memory_key = memory_key or self.memory_key
        # 新 Key 不得继承旧 Key 的用户；旧接口的显式 UUID 仍需远端归属校验。
        user_id = self.user_id if memory_key == self.memory_key and memory_url == self.memory_url else ""
        if body.memoryos.user_id:
            try:
                user_id = str(uuid.UUID(body.memoryos.user_id))
            except ValueError:
                raise ServiceError("记忆服务用户 ID 必须是有效 UUID") from None
        # 模型配置只随服务启动读取，更新用户连接时完整保留服务端模型三项。
        return replace(self, memory_url=memory_url, user_id=user_id, memory_key=memory_key)
