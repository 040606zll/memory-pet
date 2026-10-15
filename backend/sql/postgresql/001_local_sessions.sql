-- PostgreSQL 的历史迁移链支持；当前应用运行时仅连接 MySQL。
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, mode TEXT NOT NULL,
    title TEXT NOT NULL, created_at TEXT NOT NULL,
    surface VARCHAR(16) NOT NULL DEFAULT 'pet' CHECK (surface IN ('pet','memory'))
);
CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(scope,surface,created_at);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created_at);
CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL,
    status TEXT NOT NULL, memory_ids TEXT NOT NULL DEFAULT '[]', source_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_session ON candidates(session_id);
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, result TEXT
);
