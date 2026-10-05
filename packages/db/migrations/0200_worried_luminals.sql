CREATE TABLE `__new_hr_special_workday_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`employment_id` text,
	`worker_id` text,
	`work_date` text NOT NULL,
	`allowance_snapshot_json` text DEFAULT '[]' NOT NULL,
	`allowance_quantity` integer DEFAULT 0 NOT NULL,
	`applied_by` text NOT NULL,
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `hr_special_workday_rules`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_special_workday_assignments_target" CHECK(("__new_hr_special_workday_assignments"."employment_id" IS NOT NULL AND "__new_hr_special_workday_assignments"."worker_id" IS NULL) OR ("__new_hr_special_workday_assignments"."employment_id" IS NULL AND "__new_hr_special_workday_assignments"."worker_id" IS NOT NULL)),
	CONSTRAINT "ck_hr_special_workday_assignments_date" CHECK(length("__new_hr_special_workday_assignments"."work_date") = 10),
	CONSTRAINT "ck_hr_special_workday_assignments_quantity" CHECK("__new_hr_special_workday_assignments"."allowance_quantity" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_special_workday_assignments`("id", "rule_id", "employment_id", "worker_id", "work_date", "allowance_snapshot_json", "allowance_quantity", "applied_by", "applied_at") SELECT "id", "rule_id", "employment_id", "worker_id", "work_date", "allowance_snapshot_json", "allowance_quantity", "applied_by", "applied_at" FROM `hr_special_workday_assignments`;--> statement-breakpoint
DROP TABLE `hr_special_workday_assignments`;--> statement-breakpoint
ALTER TABLE `__new_hr_special_workday_assignments` RENAME TO `hr_special_workday_assignments`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_employment_date` ON `hr_special_workday_assignments` (`employment_id`,`work_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_worker_date` ON `hr_special_workday_assignments` (`worker_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_assignments_date` ON `hr_special_workday_assignments` (`work_date`,`employment_id`,`worker_id`);