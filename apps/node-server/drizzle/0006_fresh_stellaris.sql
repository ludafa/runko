ALTER TABLE `conversations` ADD `provider` text DEFAULT 'vercel' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `sandbox_id` text;