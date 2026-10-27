CREATE TABLE `captions` (
	`room_id` text NOT NULL,
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_language` text NOT NULL,
	`text` text NOT NULL,
	`translation` text DEFAULT '' NOT NULL,
	`is_final` integer NOT NULL,
	`translation_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`generation` integer NOT NULL,
	PRIMARY KEY(`room_id`, `id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`host_token_hash` text NOT NULL,
	`guest_token_hash` text,
	`host_language` text NOT NULL,
	`guest_language` text,
	`guest_status` text DEFAULT 'none' NOT NULL,
	`mode` text NOT NULL,
	`state` text DEFAULT 'waiting' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`started_at` integer,
	`host_seen_at` integer NOT NULL,
	`guest_seen_at` integer,
	`demo_index` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`last_translation_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_code_unique` ON `rooms` (`code`);--> statement-breakpoint
CREATE INDEX `rooms_expiry` ON `rooms` (`expires_at`);