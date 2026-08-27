CREATE TABLE `cryptographic_key_lifecycle_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL CHECK (`domain` IN ('credential-encryption', 'credential-lookup')),
	`key_id` text NOT NULL,
	`event_type` text NOT NULL CHECK (`event_type` IN ('MANIFEST_APPLIED', 'KEY_REGISTERED')),
	`generation` integer NOT NULL CHECK (`generation` > 0),
	`manifest_hash` text NOT NULL CHECK (length(`manifest_hash`) = 64 AND `manifest_hash` NOT GLOB '*[^0-9a-f]*'),
	`backup_reference` text,
	`command_id` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cryptographic_key_lifecycle_command` ON `cryptographic_key_lifecycle_events` (`domain`,`command_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cryptographic_key_registered_once` ON `cryptographic_key_lifecycle_events` (`domain`,`key_id`,`event_type`) WHERE "cryptographic_key_lifecycle_events"."event_type" = 'KEY_REGISTERED';--> statement-breakpoint
CREATE INDEX `idx_cryptographic_key_lifecycle_time` ON `cryptographic_key_lifecycle_events` (`domain`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `cryptographic_keyring_states` (
	`domain` text PRIMARY KEY NOT NULL CHECK (`domain` IN ('credential-encryption', 'credential-lookup')),
	`generation` integer NOT NULL CHECK (`generation` > 0),
	`manifest_hash` text NOT NULL CHECK (length(`manifest_hash`) = 64 AND `manifest_hash` NOT GLOB '*[^0-9a-f]*'),
	`active_key_id` text NOT NULL,
	`minimum_reader_version` integer DEFAULT 3 NOT NULL CHECK (`minimum_reader_version` >= 3),
	`applied_at` text NOT NULL,
	`command_id` text NOT NULL
);
