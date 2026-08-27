CREATE TABLE `audit_events` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`details_json` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_tenant_time` ON `audit_events` (`tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `authorization_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`source_type` text NOT NULL,
	`metering_mode` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`model_pattern` text NOT NULL,
	`region_code` text NOT NULL,
	`data_classes_json` text NOT NULL,
	`requests_per_minute` integer NOT NULL,
	`tokens_per_minute` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`valid_until` text NOT NULL,
	`gateway_endpoint` text NOT NULL,
	`encrypted_gateway_token` text NOT NULL,
	`gateway_token_iv` text NOT NULL,
	`encryption_key_version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`review_note` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_authorization_requests_tenant_status` ON `authorization_requests` (`tenant_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_authorization_requests_status_created` ON `authorization_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `capacity_offers` (
	`offer_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`authorization_request_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`source_type` text NOT NULL,
	`model` text NOT NULL,
	`region_code` text NOT NULL,
	`data_classes_json` text NOT NULL,
	`requests_per_minute` integer NOT NULL,
	`tokens_per_minute` integer NOT NULL,
	`concurrency` integer NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`currency` text NOT NULL,
	`price_micros_per_million_tokens` text NOT NULL,
	`status` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_until` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_capacity_offers_market` ON `capacity_offers` (`status`,`model`,`valid_until`);--> statement-breakpoint
CREATE INDEX `idx_capacity_offers_tenant_created` ON `capacity_offers` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`tenant_id` text NOT NULL,
	`operation` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`resource_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_idempotency_keys_scope` ON `idempotency_keys` (`tenant_id`,`operation`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `inference_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`buyer_tenant_id` text NOT NULL,
	`supplier_tenant_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`model` text NOT NULL,
	`data_class` text NOT NULL,
	`prompt_digest` text NOT NULL,
	`max_output_tokens` integer NOT NULL,
	`status` text NOT NULL,
	`provider_request_id` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`charge_micros` text,
	`output_ciphertext` text,
	`output_iv` text,
	`output_expires_at` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inference_jobs_idempotency` ON `inference_jobs` (`buyer_tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_inference_jobs_buyer_created` ON `inference_jobs` (`buyer_tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inference_jobs_supplier_created` ON `inference_jobs` (`supplier_tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inference_jobs_offer_status` ON `inference_jobs` (`offer_id`,`status`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`account_id` text NOT NULL,
	`job_id` text,
	`entry_type` text NOT NULL,
	`direction` text NOT NULL,
	`amount_micros` text NOT NULL,
	`currency` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_entries_tenant_created` ON `ledger_entries` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ledger_entries_job_id` ON `ledger_entries` (`job_id`);--> statement-breakpoint
CREATE TABLE `marketplace_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`causation_id` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`aggregate_version` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_marketplace_events_aggregate_version` ON `marketplace_events` (`tenant_id`,`aggregate_type`,`aggregate_id`,`aggregate_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_marketplace_events_causation` ON `marketplace_events` (`tenant_id`,`causation_id`);--> statement-breakpoint
CREATE INDEX `idx_marketplace_events_aggregate` ON `marketplace_events` (`tenant_id`,`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`supplier_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text NOT NULL,
	`country_code` text NOT NULL,
	`tax_residence_country_code` text NOT NULL,
	`status` text NOT NULL,
	`supply_enabled` integer DEFAULT 0 NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_suppliers_tenant_id` ON `suppliers` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_suppliers_user_id` ON `suppliers` (`user_id`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`usage_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`buyer_tenant_id` text NOT NULL,
	`supplier_tenant_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`provider_request_id` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`receipt_ref` text,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_usage_records_job_id` ON `usage_records` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_records_supplier_time` ON `usage_records` (`supplier_tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
