ALTER TABLE `artifact_task_evidence` ADD `digest_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `artifact_tasks` ADD `digest_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `digest_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `service_evidence` ADD `digest_version` integer DEFAULT 1 NOT NULL;