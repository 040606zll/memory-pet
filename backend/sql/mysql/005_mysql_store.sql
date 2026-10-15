-- MySQL 8 全量幂等基线，由运行时和 Alembic 005 共用。
-- 仅为新建宠物应用库创建缺失表，不导入 SQLite 数据，不操作 MemoryOS 库。
-- 绑定摘要由 INSERT 中的 UNHEX(SHA2(service_url,256)) 计算，不保存真实 API Key。
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

-- ASCII 二进制排序保留地址大小写语义，并避免复合唯一键超过 InnoDB 索引长度。
CREATE TABLE IF NOT EXISTS memory_user_bindings (
    service_url VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    service_hash BINARY(32) NOT NULL,
    api_key_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (service_hash, api_key_id),
    UNIQUE KEY memory_binding_user (service_hash, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- 本地账号与登录会话；凭据只保存带盐密码哈希和令牌摘要，不存明文密码或上游 Key。
CREATE TABLE IF NOT EXISTS local_accounts (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    password_hash VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS login_sessions (
    token_hash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    csrf_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX login_sessions_account(account_id),
    INDEX login_sessions_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS account_memory_bindings (
    account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    service_url VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    service_hash BINARY(32) NOT NULL,
    memory_user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
    api_key_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
    provision_owner VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
    lease_until BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, service_hash),
    UNIQUE KEY account_memory_user (service_hash, memory_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS login_attempts (
    bucket VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX login_attempts_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
