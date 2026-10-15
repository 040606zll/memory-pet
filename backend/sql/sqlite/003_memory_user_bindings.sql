-- 只保存上游 Key 标识与用户 UUID，不保存明文 API Key；一个服务内严格一对一。
CREATE TABLE IF NOT EXISTS memory_user_bindings (
    service_url TEXT NOT NULL,
    api_key_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (service_url, api_key_id),
    UNIQUE (service_url, user_id)
);
