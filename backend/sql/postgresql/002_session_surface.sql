-- PostgreSQL参考迁移；当前产品运行时仍仅使用SQLite。升级前确认surface列不存在。
ALTER TABLE sessions ADD COLUMN surface VARCHAR(16) NOT NULL DEFAULT 'pet' CHECK (surface IN ('pet','memory'));
