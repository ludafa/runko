CREATE TABLE `conversation_decisions` (
	`conversation_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`kind` text NOT NULL,
	`tool_name` text,
	`payload_json` text,
	`outcome` text,
	`scope` text,
	`decided_by` text,
	`message` text,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	PRIMARY KEY(`conversation_id`, `tool_call_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `turn_holder` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `turn_started_at` integer;