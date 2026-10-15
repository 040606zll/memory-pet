-- ASCII 二进制排序保留地址大小写语义，并避免复合唯一键超过 InnoDB 索引长度。
CREATE TABLE IF NOT EXISTS memory_user_bindings (
    service_url VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    service_hash BINARY(32) NOT NULL,
    api_key_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (service_hash, api_key_id),
    UNIQUE KEY memory_binding_user (service_hash, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
