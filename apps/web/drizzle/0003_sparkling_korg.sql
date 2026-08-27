CREATE TABLE `supplier_artifact_workers` (
	`supplier_tenant_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`authorization_request_ids_json` text NOT NULL,
	`allowed_models_json` text NOT NULL,
	`supported_media_types_json` text NOT NULL,
	`max_artifact_bytes` integer NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_supplier_artifact_workers_identity` ON `supplier_artifact_workers` (`supplier_tenant_id`,`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_artifact_workers_capacity` ON `supplier_artifact_workers` (`supplier_tenant_id`,`provider_id`,`expires_at`);