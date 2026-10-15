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
