CREATE TABLE `cryptographic_key_bootstrap_eligibility` (
	`domain` text PRIMARY KEY NOT NULL,
	`provenance` text NOT NULL,
	`eligible_at` text NOT NULL,
	`consumed_at` text,
	`consumed_command_id` text,
	CONSTRAINT "cryptographic_key_bootstrap_eligibility_domain_check" CHECK("cryptographic_key_bootstrap_eligibility"."domain" IN ('credential-encryption', 'credential-lookup')),
	CONSTRAINT "cryptographic_key_bootstrap_eligibility_provenance_check" CHECK("cryptographic_key_bootstrap_eligibility"."provenance" = 'migration-empty-history-v1'),
	CONSTRAINT "cryptographic_key_bootstrap_eligibility_consumption_check" CHECK(("cryptographic_key_bootstrap_eligibility"."consumed_at" IS NULL AND "cryptographic_key_bootstrap_eligibility"."consumed_command_id" IS NULL) OR
          ("cryptographic_key_bootstrap_eligibility"."consumed_at" IS NOT NULL AND "cryptographic_key_bootstrap_eligibility"."consumed_command_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `cryptographic_key_bootstrap_eligibility` (
	`domain`, `provenance`, `eligible_at`, `consumed_at`, `consumed_command_id`
)
SELECT `domain`, 'migration-empty-history-v1',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL
FROM (
	SELECT 'credential-encryption' AS `domain`
	UNION ALL SELECT 'credential-lookup'
)
WHERE NOT EXISTS (SELECT 1 FROM `users`)
	AND NOT EXISTS (SELECT 1 FROM `suppliers`)
	AND NOT EXISTS (SELECT 1 FROM `authorization_requests`)
	AND NOT EXISTS (SELECT 1 FROM `capacity_offers`)
	AND NOT EXISTS (SELECT 1 FROM `marketplace_events`)
	AND NOT EXISTS (SELECT 1 FROM `inference_jobs`)
	AND NOT EXISTS (SELECT 1 FROM `usage_records`)
	AND NOT EXISTS (SELECT 1 FROM `service_evidence`)
	AND NOT EXISTS (SELECT 1 FROM `ledger_entries`)
	AND NOT EXISTS (SELECT 1 FROM `audit_events`)
	AND NOT EXISTS (SELECT 1 FROM `idempotency_keys`)
	AND NOT EXISTS (SELECT 1 FROM `artifacts`)
	AND NOT EXISTS (SELECT 1 FROM `artifact_chunks`)
	AND NOT EXISTS (SELECT 1 FROM `artifact_object_deletions`)
	AND NOT EXISTS (SELECT 1 FROM `supplier_artifact_workers`)
	AND NOT EXISTS (SELECT 1 FROM `artifact_tasks`)
	AND NOT EXISTS (SELECT 1 FROM `artifact_task_checkpoints`)
	AND NOT EXISTS (SELECT 1 FROM `artifact_task_evidence`)
	AND NOT EXISTS (SELECT 1 FROM `agent_request_nonces`)
	AND NOT EXISTS (SELECT 1 FROM `cryptographic_key_canaries`)
	AND NOT EXISTS (SELECT 1 FROM `cryptographic_key_lifecycle_events`)
	AND NOT EXISTS (SELECT 1 FROM `cryptographic_keyring_states`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cryptographic_key_lifecycle_command_global` ON `cryptographic_key_lifecycle_events` (`command_id`);--> statement-breakpoint
DROP INDEX `idx_cryptographic_key_lifecycle_command`;
