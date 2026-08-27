CREATE TABLE `api_rate_limits` (
	`scope_key` text NOT NULL,
	`action` text NOT NULL,
	`window_started_at` text NOT NULL,
	`request_count` integer NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_rate_limits_bucket` ON `api_rate_limits` (`scope_key`,`action`,`window_started_at`);--> statement-breakpoint
CREATE INDEX `idx_api_rate_limits_expires` ON `api_rate_limits` (`expires_at`);--> statement-breakpoint
ALTER TABLE `artifact_tasks` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_tasks` ADD `content_key_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_tasks` ADD `content_purged_at` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `content_purged_at` text;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `privacy_mode` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `content_key_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `content_purged_at` text;