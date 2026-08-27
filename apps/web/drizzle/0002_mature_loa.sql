CREATE TABLE `agent_request_nonces` (
	`credential_digest` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_request_nonces_unique` ON `agent_request_nonces` (`credential_digest`,`nonce`);--> statement-breakpoint
CREATE TABLE `artifact_chunks` (
	`artifact_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`plaintext_sha256` text NOT NULL,
	`ciphertext_sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`iv` text NOT NULL,
	`uploaded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifact_chunks_part` ON `artifact_chunks` (`artifact_id`,`part_number`);--> statement-breakpoint
CREATE INDEX `idx_artifact_chunks_tenant_artifact` ON `artifact_chunks` (`tenant_id`,`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifact_task_checkpoints` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`completed_segments` integer NOT NULL,
	`total_segments` integer NOT NULL,
	`processed_bytes` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifact_task_checkpoints_task_time` ON `artifact_task_checkpoints` (`task_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `artifact_task_evidence` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`requested_model` text NOT NULL,
	`served_model` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_manifest_sha256` text NOT NULL,
	`artifact_content_sha256` text NOT NULL,
	`output_sha256` text NOT NULL,
	`provider_request_ids_sha256` text NOT NULL,
	`segments_completed` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`evidence_digest` text NOT NULL,
	`buyer_charge_micros` text NOT NULL,
	`supplier_credit_micros` text NOT NULL,
	`platform_fee_micros` text NOT NULL,
	`completed_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifact_task_evidence_task` ON `artifact_task_evidence` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_artifact_task_evidence_provider_time` ON `artifact_task_evidence` (`provider_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `artifact_tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`buyer_tenant_id` text NOT NULL,
	`supplier_tenant_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`authorization_request_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`model` text NOT NULL,
	`data_class` text NOT NULL,
	`instruction_digest` text NOT NULL,
	`instruction_ciphertext` text NOT NULL,
	`instruction_iv` text NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`max_total_tokens` integer NOT NULL,
	`reserved_charge_micros` text NOT NULL,
	`status` text NOT NULL,
	`completed_segments` integer DEFAULT 0 NOT NULL,
	`total_segments` integer,
	`processed_bytes` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`worker_id` text,
	`lease_digest` text,
	`lease_expires_at` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`charge_micros` text,
	`output_ciphertext` text,
	`output_iv` text,
	`output_expires_at` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_artifact_tasks_idempotency` ON `artifact_tasks` (`buyer_tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_artifact_tasks_buyer_created` ON `artifact_tasks` (`buyer_tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_tasks_supplier_status` ON `artifact_tasks` (`supplier_tenant_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_tasks_offer_status` ON `artifact_tasks` (`offer_id`,`status`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`chunk_size_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`uploaded_chunks` integer DEFAULT 0 NOT NULL,
	`manifest_sha256` text,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_tenant_created` ON `artifacts` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_status_expires` ON `artifacts` (`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `gateway_token_digest` text;