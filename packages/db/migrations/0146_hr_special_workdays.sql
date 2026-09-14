CREATE TABLE `hr_special_workday_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_special_workday_rules_name` CHECK(length(trim(`name`)) BETWEEN 1 AND 100),
  CONSTRAINT `ck_hr_special_workday_rules_active` CHECK(`active` IN (0, 1)),
  CONSTRAINT `ck_hr_special_workday_rules_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
CREATE TABLE `hr_special_workday_rule_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `rule_id` text NOT NULL,
  `version_number` integer NOT NULL,
  `valid_from` text NOT NULL,
  `valid_to` text,
  `wage_kind` text NOT NULL,
  `fixed_amount_minor` integer,
  `multiplier_ppm` integer,
  `overtime_rule` text NOT NULL,
  `work_source` text NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`rule_id`) REFERENCES `hr_special_workday_rules`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_special_workday_versions_dates` CHECK(length(`valid_from`) = 10 AND (`valid_to` IS NULL OR (length(`valid_to`) = 10 AND `valid_to` > `valid_from`))),
  CONSTRAINT `ck_hr_special_workday_versions_wage` CHECK((`wage_kind` = 'fixed_hourly' AND `fixed_amount_minor` IS NOT NULL AND `fixed_amount_minor` >= 0 AND `multiplier_ppm` IS NULL) OR (`wage_kind` = 'multiplier' AND `fixed_amount_minor` IS NULL AND `multiplier_ppm` IS NOT NULL AND `multiplier_ppm` >= 0)),
  CONSTRAINT `ck_hr_special_workday_versions_overtime` CHECK(length(trim(`overtime_rule`)) BETWEEN 1 AND 100),
  CONSTRAINT `ck_hr_special_workday_versions_source` CHECK(`work_source` IN ('schedule', 'hourly', 'manual')),
  CONSTRAINT `ck_hr_special_workday_versions_note` CHECK(length(`note`) <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_versions_number` ON `hr_special_workday_rule_versions` (`rule_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_versions_period` ON `hr_special_workday_rule_versions` (`valid_from`,`valid_to`);
--> statement-breakpoint
CREATE TABLE `hr_special_workday_allowances` (
  `id` text PRIMARY KEY NOT NULL,
  `rule_version_id` text NOT NULL,
  `item_name` text NOT NULL,
  `unit_amount_minor` integer NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`rule_version_id`) REFERENCES `hr_special_workday_rule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_special_workday_allowances_name` CHECK(length(trim(`item_name`)) BETWEEN 1 AND 100),
  CONSTRAINT `ck_hr_special_workday_allowances_amount` CHECK(`unit_amount_minor` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_allowances_version` ON `hr_special_workday_allowances` (`rule_version_id`);
--> statement-breakpoint
CREATE TABLE `hr_special_workday_assignments` (
  `id` text PRIMARY KEY NOT NULL,
  `rule_version_id` text NOT NULL,
  `employment_id` text,
  `worker_id` text,
  `work_date` text NOT NULL,
  `rule_name_snapshot` text NOT NULL,
  `wage_kind_snapshot` text NOT NULL,
  `fixed_amount_minor_snapshot` integer,
  `multiplier_ppm_snapshot` integer,
  `work_source_snapshot` text NOT NULL,
  `allowance_snapshot_json` text DEFAULT '[]' NOT NULL,
  `allowance_quantity` integer DEFAULT 0 NOT NULL,
  `applied_by` text NOT NULL,
  `applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`rule_version_id`) REFERENCES `hr_special_workday_rule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_special_workday_assignments_target` CHECK((`employment_id` IS NOT NULL AND `worker_id` IS NULL) OR (`employment_id` IS NULL AND `worker_id` IS NOT NULL)),
  CONSTRAINT `ck_hr_special_workday_assignments_date` CHECK(length(`work_date`) = 10),
  CONSTRAINT `ck_hr_special_workday_assignments_quantity` CHECK(`allowance_quantity` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_employment_date` ON `hr_special_workday_assignments` (`employment_id`,`work_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_worker_date` ON `hr_special_workday_assignments` (`worker_id`,`work_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_assignments_date` ON `hr_special_workday_assignments` (`work_date`,`employment_id`,`worker_id`);
