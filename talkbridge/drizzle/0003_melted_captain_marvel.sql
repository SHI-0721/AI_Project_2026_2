ALTER TABLE `rooms` ADD `host_listening` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `guest_listening` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `host_capture_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `guest_capture_generation` integer DEFAULT 0 NOT NULL;