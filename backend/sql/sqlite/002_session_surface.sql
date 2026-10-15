-- 旧库升级；Store在BEGIN IMMEDIATE和PRAGMA确认列不存在后执行。手工执行前也须确认列不存在。
ALTER TABLE sessions ADD COLUMN surface TEXT NOT NULL DEFAULT 'pet' CHECK (surface IN ('pet','memory'));
