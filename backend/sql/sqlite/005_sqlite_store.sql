-- SQLite 本机测试基线，与 mysql/005_mysql_store.sql 表结构一一对应。
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mode TEXT NOT NULL, title TEXT NOT NULL,
    created_at TEXT NOT NULL, surface TEXT NOT NULL DEFAULT 'pet' CHECK (surface IN ('pet', 'memory'))
);
CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(scope, surface, created_at);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
    memory_ids TEXT NOT NULL, source_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_session ON candidates(session_id);
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT
);
CREATE TABLE IF NOT EXISTS memory_user_bindings (
    service_url TEXT NOT NULL, service_hash BLOB NOT NULL, api_key_id TEXT NOT NULL, user_id TEXT NOT NULL,
    PRIMARY KEY (service_hash, api_key_id), UNIQUE (service_hash, user_id)
);
CREATE TABLE IF NOT EXISTS local_accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_sessions (
    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_sessions_account ON login_sessions(account_id);
CREATE INDEX IF NOT EXISTS login_sessions_expiry ON login_sessions(expires_at);
CREATE TABLE IF NOT EXISTS account_memory_bindings (
    account_id TEXT NOT NULL, service_url TEXT NOT NULL, service_hash BLOB NOT NULL, memory_user_id TEXT,
    api_key_id TEXT, provision_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, service_hash), UNIQUE (service_hash, memory_user_id)
);
CREATE TABLE IF NOT EXISTS login_attempts (
    bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_expiry ON login_attempts(expires_at);
