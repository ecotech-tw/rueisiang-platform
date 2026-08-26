CREATE TABLE `cyberbiz_report_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`report_kind` text NOT NULL,
	`period_kind` text NOT NULL,
	`stores_json` text DEFAULT '[]' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`manifest_eligible` integer DEFAULT 0 NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cyberbiz_report_runs_request_id` ON `cyberbiz_report_runs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_report_runs_kind_created_at` ON `cyberbiz_report_runs` (`report_kind`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_cyberbiz_report_manifest_version`;--> statement-breakpoint
ALTER TABLE `cyberbiz_report_manifests` ADD `report_kind` text DEFAULT 'bundle' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cyberbiz_report_manifest_version` ON `cyberbiz_report_manifests` (`report_month`,`scope_type`,`scope_id`,`report_kind`,`source_checksum`);