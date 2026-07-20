ALTER TABLE `agent_events` ADD `kind` text NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `nimbo_session_id` text;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `nimbo_created_at` integer;--> statement-breakpoint
ALTER TABLE `chat_sessions` ADD `nimbo_turn` integer;