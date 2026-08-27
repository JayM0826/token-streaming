ALTER TABLE `artifact_chunks` ADD `upload_status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_tasks` ADD `cancellation_requested_at` text;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `gateway_token_digest_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `review_command_id` text;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `reserved_charge_micros` text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `reservation_expires_at` text;--> statement-breakpoint
ALTER TABLE `marketplace_events` ADD `schema_version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE `inference_jobs` SET `status` = 'failed', `reservation_expires_at` = NULL,
  `error_code` = COALESCE(`error_code`, 'EXECUTION_MIGRATED'),
  `completed_at` = COALESCE(`completed_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE `status` IN ('reserved', 'running');
--> statement-breakpoint
UPDATE `users` SET `email` = 'redacted@identity.invalid', `display_name` = '平台成员',
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `email` <> 'redacted@identity.invalid' OR `display_name` <> '平台成员';
