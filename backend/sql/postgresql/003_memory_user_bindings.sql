-- 宠物项目的逻辑绑定，不操作 MemoryOS 用户表。
CREATE TABLE IF NOT EXISTS memory_user_bindings (
    service_url VARCHAR(2048) NOT NULL,
    api_key_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    PRIMARY KEY (service_url, api_key_id),
    UNIQUE (service_url, user_id)
);
