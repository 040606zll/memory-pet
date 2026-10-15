"""本地账号、会话与记忆用户映射；所有数据库访问均为独立短事务。"""
import hashlib
import secrets
from sqlalchemy.exc import IntegrityError
import time
import uuid

from .errors import ServiceError
from .store import now


class Accounts:
    def __init__(self, store):
        self.store = store

    def create(self, username, password_hash):
        account = {"id": str(uuid.uuid4()), "username": username, "password_hash": password_hash, "created_at": now()}
        try:
            with self.store.db() as db:
                db.execute("INSERT INTO local_accounts(id,username,password_hash,created_at) VALUES(%s,%s,%s,%s)", tuple(account.values()))
        except IntegrityError:
            raise ServiceError("此账号已注册，请直接登录或更换账号", 409) from None
        return account

    def get(self, account_id):
        with self.store.db() as db:
            row = db.execute("SELECT * FROM local_accounts WHERE id=%s", (account_id,)).fetchone()
        return dict(row) if row else None

    def by_username(self, username):
        with self.store.db() as db:
            row = db.execute("SELECT * FROM local_accounts WHERE username=%s", (username,)).fetchone()
        return dict(row) if row else None

    def throttle(self, keys, limit=5):
        current = int(time.time())
        keys = sorted(set(keys))
        if not keys:
            return
        placeholders = ','.join('%s' for _ in keys)
        values = ','.join('(%s,0,%s)' for _ in keys)
        params = [value for key in keys for value in (key, current + 900)]
        with self.store.db() as db:
            # 按固定顺序批量取得唯一键锁，过期桶就地重置，不在循环中往返数据库。
            db.execute(f"INSERT INTO login_attempts(bucket,attempts,expires_at) VALUES {values} ON DUPLICATE KEY UPDATE attempts=IF(expires_at<=%s,0,attempts),expires_at=IF(expires_at<=%s,VALUES(expires_at),expires_at)", [*params, current, current])
            rows = db.execute(f"SELECT bucket,attempts FROM login_attempts WHERE bucket IN ({placeholders}) ORDER BY bucket FOR UPDATE", keys).fetchall()
            if any(row["attempts"] >= limit for row in rows):
                raise ServiceError("尝试次数过多，请十五分钟后重试", 429)
            db.execute(f"UPDATE login_attempts SET attempts=attempts+1 WHERE bucket IN ({placeholders})", keys)

    def clear_attempt(self, key):
        with self.store.db() as db:
            db.execute("DELETE FROM login_attempts WHERE bucket=%s", (key,))

    def new_session(self, account_id, previous_token=None):
        token, csrf_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        expires = int(time.time()) + 7 * 24 * 3600
        with self.store.db() as db:
            db.execute("DELETE FROM login_sessions WHERE expires_at<=%s", (int(time.time()),))
            if previous_token:
                db.execute("DELETE FROM login_sessions WHERE token_hash=%s", (self.digest(previous_token),))
            db.execute("INSERT INTO login_sessions(token_hash,account_id,csrf_token,expires_at) VALUES(%s,%s,%s,%s)", (self.digest(token), account_id, csrf_token, expires))
        return token, csrf_token

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def authenticate(self, token):
        if not token or len(token) > 256:
            raise ServiceError("请先登录账号", 401)
        with self.store.db() as db:
            row = db.execute("SELECT a.id,a.username,s.csrf_token FROM login_sessions s JOIN local_accounts a ON a.id=s.account_id WHERE s.token_hash=%s AND s.expires_at>%s", (self.digest(token), int(time.time()))).fetchone()
        if row is None:
            raise ServiceError("登录已失效，请重新登录", 401)
        return dict(row)

    def logout(self, token):
        with self.store.db() as db:
            db.execute("DELETE FROM login_sessions WHERE token_hash=%s", (self.digest(token),))

    def binding(self, account_id, service_url):
        with self.store.db() as db:
            row = db.execute("SELECT * FROM account_memory_bindings WHERE account_id=%s AND service_url=%s", (account_id, service_url)).fetchone()
        return dict(row) if row else None

    def claim(self, account_id, service_url, owner=None):
        owner, current = owner or str(uuid.uuid4()), int(time.time())
        with self.store.db() as db:
            db.execute("INSERT INTO account_memory_bindings(account_id,service_url,service_hash) VALUES(%s,%s,UNHEX(SHA2(%s,256))) ON DUPLICATE KEY UPDATE account_id=account_id", (account_id, service_url, service_url))
            result = db.execute("UPDATE account_memory_bindings SET provision_owner=%s,lease_until=%s WHERE account_id=%s AND service_url=%s AND memory_user_id IS NULL AND lease_until<=%s", (owner, current + 300, account_id, service_url, current))
            if result.rowcount != 1:
                raise ServiceError("记忆账户正在初始化，请稍后重试", 409)
        return owner

    def release(self, account_id, service_url, owner):
        with self.store.db() as db:
            db.execute("UPDATE account_memory_bindings SET provision_owner=NULL,lease_until=0 WHERE account_id=%s AND service_url=%s AND provision_owner=%s", (account_id, service_url, owner))

    def bind(self, account_id, service_url, owner, user_id, key_id):
        try:
            with self.store.db() as db:
                result = db.execute("UPDATE account_memory_bindings SET memory_user_id=%s,api_key_id=%s,provision_owner=NULL,lease_until=0 WHERE account_id=%s AND service_url=%s AND provision_owner=%s AND memory_user_id IS NULL", (user_id, key_id, account_id, service_url, owner))
                if result.rowcount != 1:
                    raise ServiceError("记忆账户初始化状态已变化，请稍后重试", 409)
        except IntegrityError:
            raise ServiceError("该记忆用户已关联其他账号，请联系管理员处理", 409) from None
