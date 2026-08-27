CREATE TABLE `service_evidence` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`requested_model` text NOT NULL,
	`served_model` text NOT NULL,
	`provider_request_id` text NOT NULL,
	`assurance` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`input_digest` text NOT NULL,
	`output_digest` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`unit_price_micros_per_million_tokens` text NOT NULL,
	`buyer_charge_micros` text NOT NULL,
	`supplier_credit_micros` text NOT NULL,
	`platform_fee_micros` text NOT NULL,
	`receipt_ref` text,
	`provider_completed_at` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_service_evidence_job_id` ON `service_evidence` (`job_id`);--> statement-breakpoint
CREATE INDEX `idx_service_evidence_provider_time` ON `service_evidence` (`provider_id`,`recorded_at`);