CREATE TABLE `cyberbiz_report_manifests` (
	`id` text PRIMARY KEY NOT NULL,
	`report_month` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`scope_name` text DEFAULT '' NOT NULL,
	`coverage_start` text NOT NULL,
	`coverage_end` text NOT NULL,
	`sales_granularity` text DEFAULT 'month' NOT NULL,
	`payout_granularity` text DEFAULT 'day' NOT NULL,
	`sales_object_key` text,
	`payout_object_key` text,
	`combined_workbook_object_key` text,
	`drive_file_id` text,
	`drive_url` text,
	`store_ids_json` text DEFAULT '[]' NOT NULL,
	`source_checksum` text NOT NULL,
	`parser_version` text NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cyberbiz_report_manifest_version` ON `cyberbiz_report_manifests` (`report_month`,`scope_type`,`scope_id`,`source_checksum`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_report_manifest_lookup` ON `cyberbiz_report_manifests` (`report_month`,`scope_type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_report_manifest_scope` ON `cyberbiz_report_manifests` (`scope_id`,`report_month`);
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'reports:cyberbiz:read' FROM roles WHERE key IN ('admin', 'manager');
