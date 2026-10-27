ALTER TABLE `captions` ADD `speaker_id` text;--> statement-breakpoint
ALTER TABLE `captions` ADD `speaker_side` text;--> statement-breakpoint
ALTER TABLE `captions` ADD `target_language` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `device_mode` text DEFAULT 'paired' NOT NULL;