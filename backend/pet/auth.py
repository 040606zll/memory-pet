"""账号密码与浏览器会话；使用标准库 scrypt，无额外依赖。"""
import asyncio
import hashlib
import hmac
import secrets

from .errors import ServiceError
from .database import run_db

COOKIE_NAME = "memory_pet_session"
SESSION_AGE = 7 * 24 * 3600


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"scrypt$16384$8$1${salt}${digest}"


def verify_password(password, encoded):
    try:
        name, n, r, p, salt, expected = encoded.split("$")
        if (name, n, r, p) != ("scrypt", "16384", "8", "1"):
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p)).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


class Auth:
    def __init__(self, accounts):
        self.accounts = accounts
        # 不存在的账号也执行同等密码计算，减少通过响应时间枚举账号的机会。
        self.dummy_hash = hash_password(secrets.token_urlsafe(24))

    async def credentials(self, username, password, address, *, register=False):
        ip_key = f"{'register' if register else 'login'}:ip:{self.accounts.digest(address)}"
        await run_db(self.accounts.throttle, [ip_key], limit=30)
        account_key = f"login:account:{self.accounts.digest(username)}"
        if register:
            password_hash = await asyncio.to_thread(hash_password, password)
            return await run_db(self.accounts.create, username, password_hash)
        await run_db(self.accounts.throttle, [account_key])
        account = await run_db(self.accounts.by_username, username)
        valid = await asyncio.to_thread(verify_password, password, account["password_hash"] if account else self.dummy_hash)
        if not account or not valid:
            raise ServiceError("账号或密码不正确", 401)
        await run_db(self.accounts.clear_attempt, account_key)
        return account


def public_user(account):
    return {"id": account["id"], "username": account["username"]}
