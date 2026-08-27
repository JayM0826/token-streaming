ALTER TABLE `artifact_tasks` ADD `authorization_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `authorization_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `credential_rotated_at` text;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `authorization_requests` ADD `revocation_reason_code` text;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `authorization_request_id` text;--> statement-breakpoint
ALTER TABLE `inference_jobs` ADD `authorization_revision` integer;--> statement-breakpoint
UPDATE `inference_jobs`
SET `authorization_request_id` = (
  SELECT `o`.`authorization_request_id`
  FROM `capacity_offers` `o`
  WHERE `o`.`offer_id` = `inference_jobs`.`offer_id`
), `authorization_revision` = (
  SELECT `ar`.`authorization_revision`
  FROM `capacity_offers` `o`
  JOIN `authorization_requests` `ar` ON `ar`.`request_id` = `o`.`authorization_request_id`
  WHERE `o`.`offer_id` = `inference_jobs`.`offer_id`
)
WHERE `authorization_request_id` IS NULL AND EXISTS (
  SELECT 1
  FROM `capacity_offers` `o`
  JOIN `authorization_requests` `ar` ON `ar`.`request_id` = `o`.`authorization_request_id`
  WHERE `o`.`offer_id` = `inference_jobs`.`offer_id`
);
