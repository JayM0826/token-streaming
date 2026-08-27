CREATE TABLE `artifact_object_deletions` (
	`storage_key` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`next_attempt_at` text NOT NULL,
	`retain_until` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_object_deletions_due` ON `artifact_object_deletions` (`next_attempt_at`,`retain_until`);--> statement-breakpoint
CREATE INDEX `idx_artifact_object_deletions_artifact` ON `artifact_object_deletions` (`tenant_id`,`artifact_id`);