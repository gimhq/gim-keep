CREATE TABLE `gim_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`reported_user_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`messages` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`request_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gim_reports_request_digest_unique` ON `gim_reports` (`request_digest`);--> statement-breakpoint
CREATE INDEX `idx_gim_reports_status_created` ON `gim_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `gim_slots` (
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `name`)
);
