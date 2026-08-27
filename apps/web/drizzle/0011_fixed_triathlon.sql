CREATE TABLE `cryptographic_key_canaries` (
	`canary_id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`key_id` text NOT NULL,
	`format_version` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cryptographic_key_canaries_domain_key` ON `cryptographic_key_canaries` (`domain`,`key_id`);--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `credential_key_id` text DEFAULT 'legacy-credential-v2' NOT NULL;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `gateway_token_lookup_key_id` text DEFAULT 'legacy-commitment-v2' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_authorization_requests_lookup_status` ON `authorization_requests` (`gateway_token_digest_version`,`gateway_token_lookup_key_id`,`gateway_token_digest`,`status`,`valid_until`);