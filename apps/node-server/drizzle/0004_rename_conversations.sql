-- 表/列更名（docs/plans/chat-observability.md 2026-07-17）：
-- 1) chat_sessions → conversations、agent_events → conversation_events——
--    解开 "session" 三重超载（better-auth 登录态 / 对话线程 / SDK agent 会话），
--    子表按父实体命名；
-- 2) nimbo_* 列 → agent_session_*——库表命名不带产品名，产品更名不迁库；
-- 3) 删除 conversation_events.type（payload 判别字段的冗余镜像，无代码读取，
--    临时查询用 json_extract(payload_json, '$.type')）。
-- SQLite 的 RENAME TO / RENAME COLUMN 原地保数据并自动改写外键引用。
ALTER TABLE `chat_sessions` RENAME TO `conversations`;--> statement-breakpoint
ALTER TABLE `agent_events` RENAME TO `conversation_events`;--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `nimbo_session_id` TO `agent_session_id`;--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `nimbo_created_at` TO `agent_session_created_at`;--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `nimbo_turn` TO `agent_session_turn`;--> statement-breakpoint
ALTER TABLE `conversation_events` RENAME COLUMN `session_id` TO `conversation_id`;--> statement-breakpoint
ALTER TABLE `conversation_events` DROP COLUMN `type`;
