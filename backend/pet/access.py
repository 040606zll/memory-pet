"""校验部署入口白名单；账号身份由应用登录会话负责。"""
from dataclasses import dataclass
from ipaddress import ip_address
import re
from urllib.parse import urlsplit

from .errors import ServiceError


LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "testserver"})


def hostname(value):
    value = value.lower()
    try:
        return str(ip_address(value))
    except ValueError:
        # 显式完整域名，不接受通配符、URL、端口或模糊后缀匹配。
        if len(value) > 253 or not value or not all(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in value.split(".")
        ):
            raise ValueError("访问主机格式无效") from None
        return value


def authority(value):
    if not value or any(char.isspace() for char in value) or any(char in value for char in "/?#@\\") or value.endswith(":"):
        raise ValueError("访问地址格式无效")
    parsed = urlsplit("//" + value)
    host = hostname(parsed.hostname or "")
    port = parsed.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("访问端口无效")
    return host, port


def origin(value):
    if any(char.isspace() for char in value) or "?" in value or "#" in value:
        raise ValueError("来源格式无效")
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.path not in {"", "/"}:
        raise ValueError("来源必须包含 HTTP 协议且不能带路径")
    host, port = authority(parsed.netloc)
    # 标准默认端口视为同一来源；其他端口严格区分。
    return parsed.scheme, host, port or (443 if parsed.scheme == "https" else 80)


def entries(value):
    if not value.strip():
        return []
    items = [item.strip() for item in value.split(",")]
    if not all(items):
        raise ValueError("白名单存在空项")
    return items


@dataclass(frozen=True)
class AccessPolicy:
    hosts: frozenset
    origins: frozenset

    @classmethod
    def from_settings(cls, settings):
        try:
            hosts = frozenset(hostname(item) for item in entries(settings.get("PET_ALLOWED_HOSTS", "")))
        except ValueError:
            raise ServiceError("server.allowed_hosts 配置无效，请填写逗号分隔的 IP 或完整域名，不含协议、端口或通配符", 500) from None
        try:
            origins = frozenset(origin(item) for item in entries(settings.get("PET_ALLOWED_ORIGINS", "")))
        except ValueError:
            raise ServiceError("server.allowed_origins 配置无效，请填写逗号分隔的完整 HTTP 来源地址，不含路径、查询或通配符", 500) from None
        return cls(LOCAL_HOSTS | hosts, origins)

    def rejection(self, headers):
        try:
            if len(headers.getlist("host")) != 1:
                raise ValueError("缺少或重复的主机头")
            host, _ = authority(headers["host"])
            if host not in self.hosts:
                raise ValueError("主机未获允许")
        except ValueError:
            return "此服务仅允许本机访问" if self.hosts == LOCAL_HOSTS else "访问地址未获允许，请检查后端 server.allowed_hosts 配置"
        supplied_origins = headers.getlist("origin")
        if supplied_origins:
            try:
                if len(supplied_origins) != 1:
                    raise ValueError("重复的来源头")
                source = origin(supplied_origins[0])
                if source[1] not in LOCAL_HOSTS and source not in self.origins:
                    raise ValueError("来源未获允许")
            except ValueError:
                return "不允许来自其他网站的请求，请检查后端 server.allowed_origins 配置"
        # 白名单只允许部署入口，不能覆盖浏览器的跨站请求拦截。
        if any(value.strip().lower() == "cross-site" for value in headers.getlist("sec-fetch-site")):
            return "不允许跨站请求"
        return None
