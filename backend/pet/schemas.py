"""接口参数与模型输出校验，动作只能来自已实现的白名单。"""
from typing import Literal
import re
from pydantic import BaseModel, Field, ConfigDict, field_validator

Mode = Literal["training", "chat"]
Surface = Literal["pet", "memory"]
ActionName = Literal["blink", "wave", "nod", "shake_head", "stretch", "happy", "sleep", "wag_tail"]
ACTIONS = ["blink", "wave", "nod", "shake_head", "stretch", "happy", "sleep", "wag_tail"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MemoryConnection(StrictModel):
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)
    user_id: str | None = Field(default=None, min_length=1, max_length=128)


class ConnectBody(StrictModel):
    # 禁止客户端附带模型配置，模型始终由宠物后端环境管理。
    memoryos: MemoryConnection


class AccountBody(StrictModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9_]{3,32}", value):
            raise ValueError("账号应为三到三十二位字母、数字或下划线")
        return value


class RetryConnectionBody(StrictModel):
    """连接参数全部来自服务端，拒绝浏览器覆盖 Key 或用户。"""


class SessionBody(StrictModel):
    surface: Surface = "pet"
    mode: Mode = "training"
    title: str = Field(default="和小忆的故事", min_length=1, max_length=100)


class ModeBody(StrictModel):
    mode: Mode


class ChatBody(StrictModel):
    pet_name: str = Field(default="小忆", min_length=1, max_length=12)
    content: str = Field(min_length=1, max_length=4096)
    request_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")

    @field_validator("content")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("消息不能为空")
        return value.strip()


class CandidateBody(StrictModel):
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    status: Literal["rejected"] | None = None


class ConfirmBody(StrictModel):
    candidate_id: str = Field(min_length=1, max_length=128)


class ModelOutput(StrictModel):
    reply: str = Field(min_length=1, max_length=8000)
    emotion: Literal["neutral", "happy", "sad", "curious", "sleepy", "excited"] = "neutral"
    actions: list[ActionName] = Field(default_factory=list, max_length=3)
    candidates: list[str] = Field(default_factory=list, max_length=5)
    pet_name: str | None = Field(default=None, max_length=12)

    @classmethod
    def from_model(cls, value):
        # 回复正文必须真实且有效；可选情绪/动作不应令有效正文整体失效。
        if not isinstance(value, dict):
            raise ValueError("模型输出必须是 JSON 对象")
        emotion = value.get("emotion")
        if not isinstance(emotion, str) or emotion not in {"neutral", "happy", "sad", "curious", "sleepy", "excited"}:
            emotion = "neutral"
        actions = value.get("actions")
        actions = [n for n in actions if isinstance(n, str) and n in ACTIONS][:3] if isinstance(actions, list) else []
        candidates = value.get("candidates")
        candidates = [v.strip() for v in candidates if isinstance(v, str) and v.strip() and len(v) <= 2000][:5] if isinstance(candidates, list) else []
        return cls(reply=value.get("reply"), emotion=emotion, actions=actions, candidates=candidates, pet_name=value.get("pet_name"))

    @field_validator("pet_name", mode="before")
    @classmethod
    def optional_pet_name(cls, value):
        # 名字只是可选展示数据；供应商漏填或返回非法值时仍保留有效回复正文。
        if not isinstance(value, str):
            return None
        name = value.strip()
        if not 1 <= len(name) <= 12 or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name):
            return None
        return name

    @field_validator("reply")
    @classmethod
    def nonempty_reply(cls, value):
        if not value.strip():
            raise ValueError("模型回复不能为空")
        return value.strip()

    @field_validator("candidates")
    @classmethod
    def bounded_candidates(cls, values):
        if any(not v.strip() or len(v) > 2000 for v in values):
            raise ValueError("训练候选不能为空或过长")
        return list(dict.fromkeys(v.strip() for v in values))
