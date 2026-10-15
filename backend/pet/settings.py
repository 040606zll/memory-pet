"""加载后端配置，环境覆盖不写回进程环境或配置文件。"""
import os
from pathlib import Path
import tomllib

from .errors import ServiceError

CONFIG_FILE = Path(__file__).resolve().parents[1] / "config.toml"
LOCAL_CONFIG_FILE = CONFIG_FILE.with_name("config.local.toml")
FIELDS = {
    "speech": {"api_key": "PET_SPEECH_API_KEY", "url": "PET_SPEECH_URL", "tts_model": "PET_TTS_MODEL", "voice": "PET_TTS_VOICE", "asr_model": "PET_ASR_MODEL"},
    "llm": {"base_url": "LLM_BASE_URL", "api_key": "LLM_API_KEY", "model": "LLM_MODEL"},
    "memoryos": {"base_url": "MEMORYOS_BASE_URL", "api_key": "MEMORYOS_API_KEY", "user_id": "MEMORYOS_USER_ID"},
    "mysql": {"host": "PET_MYSQL_HOST", "port": "PET_MYSQL_PORT", "database": "PET_MYSQL_DATABASE", "user": "PET_MYSQL_USER", "password": "PET_MYSQL_PASSWORD"},
    "server": {"allowed_hosts": "PET_ALLOWED_HOSTS", "allowed_origins": "PET_ALLOWED_ORIGINS"},
}


def load_settings():
    values = {}
    for path in (CONFIG_FILE, LOCAL_CONFIG_FILE):
        try:
            with path.open("rb") as source:
                document = tomllib.load(source)
        except FileNotFoundError:
            # 缺省文件时仍支持原有纯环境变量部署。
            continue
        except (OSError, ValueError):
            # 解析错误可能包含密钥所在行，不能将原始异常写入响应或启动日志。
            raise ServiceError("后端配置文件无法读取或 TOML 格式无效，请检查配置文件", 500) from None
        for section, fields in document.items():
            if section not in FIELDS or not isinstance(fields, dict):
                raise ServiceError("后端配置存在未知配置分组或分组格式错误", 500)
            for field, value in fields.items():
                if field not in FIELDS[section] or not (isinstance(value, str) or (section == 'mysql' and field == 'port' and type(value) is int)):
                    raise ServiceError("后端配置存在未知字段或非文本值，请对照 config.toml 检查", 500)
                name = FIELDS[section][field]
                values[name] = value
    for fields in FIELDS.values():
        for name in fields.values():
            if name in os.environ:
                values[name] = os.environ[name]
    return values
