ALTER TABLE `artifact_tasks` ADD `execution_deadline_at` text;
--> statement-breakpoint
UPDATE `artifact_tasks` SET `status` = 'failed', `lease_digest` = NULL,
  `lease_expires_at` = NULL, `execution_deadline_at` = NULL,
  `instruction_ciphertext` = '', `instruction_iv` = '',
  `error_code` = 'EXECUTION_MIGRATED',
  `completed_at` = COALESCE(`completed_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE `status` IN ('claimed', 'running');
