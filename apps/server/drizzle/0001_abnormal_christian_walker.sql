CREATE TABLE `agent_events` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`session_id`, `seq`),
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`repo` text NOT NULL,
	`branch_name` text NOT NULL,
	`sandbox_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_active_at` integer NOT NULL,
	`nimbo_state_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
