-- 新建宠物应用数据库的会话表；长期记忆仍由 MemoryOS 管理。
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(100) NOT NULL,
    created_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    surface VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pet',
    INDEX sessions_scope (scope, surface, created_at),
    CONSTRAINT ck_sessions_surface CHECK (surface IN ('pet', 'memory'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    session_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    body LONGTEXT NOT NULL,
    created_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    INDEX messages_session (session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS candidates (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    session_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    content TEXT NOT NULL,
    status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    memory_ids LONGTEXT NOT NULL,
    source_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    INDEX candidates_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS operations (
    id VARCHAR(192) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    session_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    fingerprint VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
