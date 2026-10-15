-- 本地账号与登录会话；凭据只保存带盐密码哈希和令牌摘要，不存明文密码或上游 Key。
CREATE TABLE IF NOT EXISTS local_accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_sessions_account ON login_sessions(account_id);
CREATE TABLE IF NOT EXISTS account_memory_bindings (
    account_id TEXT NOT NULL,
    service_url TEXT NOT NULL,
    memory_user_id TEXT,
    api_key_id TEXT,
    provision_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, service_url),
    UNIQUE (service_url, memory_user_id)
);
CREATE TABLE IF NOT EXISTS login_attempts (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
