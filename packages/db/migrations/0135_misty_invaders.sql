CREATE TABLE `hr_overtime_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text,
	`requested_start` text NOT NULL,
	`requested_end` text NOT NULL,
	`actual_start` text,
	`actual_end` text,
	`settlement_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rate_ppm` integer DEFAULT 1333333 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`decision_reason` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_overtime_requested_period" CHECK("hr_overtime_requests"."requested_end" > "hr_overtime_requests"."requested_start"),
	CONSTRAINT "ck_hr_overtime_actual_pair" CHECK(("hr_overtime_requests"."actual_start" IS NULL AND "hr_overtime_requests"."actual_end" IS NULL) OR ("hr_overtime_requests"."actual_start" IS NOT NULL AND "hr_overtime_requests"."actual_end" IS NOT NULL AND "hr_overtime_requests"."actual_end" > "hr_overtime_requests"."actual_start")),
	CONSTRAINT "ck_hr_overtime_settlement" CHECK("hr_overtime_requests"."settlement_kind" IN ('pay', 'compensatory')),
	CONSTRAINT "ck_hr_overtime_status" CHECK("hr_overtime_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_overtime_rate" CHECK("hr_overtime_requests"."rate_ppm" BETWEEN 0 AND 10000000),
	CONSTRAINT "ck_hr_overtime_reason" CHECK(length("hr_overtime_requests"."reason") <= 1000),
	CONSTRAINT "ck_hr_overtime_decision_reason" CHECK(length("hr_overtime_requests"."decision_reason") <= 1000),
	CONSTRAINT "ck_hr_overtime_revision" CHECK("hr_overtime_requests"."revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_employment_start` ON `hr_overtime_requests` (`employment_id`,`requested_start`);--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_status` ON `hr_overtime_requests` (`status`,`requested_start`);--> statement-breakpoint
CREATE TABLE `hr_schedule_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_version_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`shift_version_id` text NOT NULL,
	`work_date` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`schedule_version_id`) REFERENCES `hr_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_version_id`) REFERENCES `hr_shift_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_entries_date" CHECK(length("hr_schedule_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_schedule_entries_period" CHECK("hr_schedule_entries"."ends_at" > "hr_schedule_entries"."starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_entries_unique` ON `hr_schedule_entries` (`schedule_version_id`,`employment_id`,`work_date`,`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_employment_date` ON `hr_schedule_entries` (`employment_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_scope_date` ON `hr_schedule_entries` (`scope_id`,`work_date`);--> statement-breakpoint
CREATE TABLE `hr_schedule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`version_number` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`submitted_by` text,
	`approved_by` text,
	`decision_reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_versions_dates" CHECK(length("hr_schedule_versions"."period_start") = 10 AND length("hr_schedule_versions"."period_end") = 10 AND "hr_schedule_versions"."period_end" > "hr_schedule_versions"."period_start"),
	CONSTRAINT "ck_hr_schedule_versions_number" CHECK("hr_schedule_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_schedule_versions_status" CHECK("hr_schedule_versions"."status" IN ('draft', 'pending', 'published', 'rejected', 'superseded')),
	CONSTRAINT "ck_hr_schedule_versions_reason" CHECK(length("hr_schedule_versions"."decision_reason") <= 1000),
	CONSTRAINT "ck_hr_schedule_versions_revision" CHECK("hr_schedule_versions"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_versions_period` ON `hr_schedule_versions` (`period_start`,`period_end`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_versions_status` ON `hr_schedule_versions` (`status`,`period_start`);--> statement-breakpoint
CREATE TABLE `hr_shift_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_shift_templates_code" CHECK(length(trim("hr_shift_templates"."code")) BETWEEN 1 AND 40),
	CONSTRAINT "ck_hr_shift_templates_name" CHECK(length(trim("hr_shift_templates"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_shift_templates_active" CHECK("hr_shift_templates"."active" IN (0, 1)),
	CONSTRAINT "ck_hr_shift_templates_revision" CHECK("hr_shift_templates"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_shift_templates_code` ON `hr_shift_templates` (`code`);--> statement-breakpoint
CREATE TABLE `hr_shift_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_template_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`start_second` integer NOT NULL,
	`end_second` integer NOT NULL,
	`end_day_offset` integer DEFAULT 0 NOT NULL,
	`pay_factor_ppm` integer DEFAULT 1000000 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`shift_template_id`) REFERENCES `hr_shift_templates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_shift_versions_number" CHECK("hr_shift_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_shift_versions_start" CHECK("hr_shift_versions"."start_second" BETWEEN 0 AND 86399),
	CONSTRAINT "ck_hr_shift_versions_end" CHECK("hr_shift_versions"."end_second" BETWEEN 0 AND 86399),
	CONSTRAINT "ck_hr_shift_versions_day_offset" CHECK("hr_shift_versions"."end_day_offset" BETWEEN 0 AND 1),
	CONSTRAINT "ck_hr_shift_versions_period" CHECK("hr_shift_versions"."end_day_offset" = 1 OR "hr_shift_versions"."end_second" > "hr_shift_versions"."start_second"),
	CONSTRAINT "ck_hr_shift_versions_factor" CHECK("hr_shift_versions"."pay_factor_ppm" BETWEEN 0 AND 10000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_shift_versions_number` ON `hr_shift_versions` (`shift_template_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_shift_versions_template` ON `hr_shift_versions` (`shift_template_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hr_bonus_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`bonus_pool_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`weight_units` integer NOT NULL,
	`scheduled_days` integer NOT NULL,
	`revenue_minor` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`rounding_adjustment_minor` integer DEFAULT 0 NOT NULL,
	`explanation_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`bonus_pool_id`) REFERENCES `hr_bonus_pools`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_allocations_weight" CHECK("hr_bonus_allocations"."weight_units" > 0),
	CONSTRAINT "ck_hr_bonus_allocations_days" CHECK("hr_bonus_allocations"."scheduled_days" >= 0),
	CONSTRAINT "ck_hr_bonus_allocations_revenue" CHECK("hr_bonus_allocations"."revenue_minor" >= 0),
	CONSTRAINT "ck_hr_bonus_allocations_amount" CHECK("hr_bonus_allocations"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_allocations_pool_employment` ON `hr_bonus_allocations` (`bonus_pool_id`,`employment_id`);--> statement-breakpoint
CREATE TABLE `hr_bonus_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_policies_name" CHECK(length(trim("hr_bonus_policies"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_bonus_policies_active" CHECK("hr_bonus_policies"."active" IN (0, 1)),
	CONSTRAINT "ck_hr_bonus_policies_revision" CHECK("hr_bonus_policies"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `hr_bonus_policy_members` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_version_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`weight_units` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_bonus_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_policy_members_dates" CHECK(length("hr_bonus_policy_members"."valid_from") = 10 AND ("hr_bonus_policy_members"."valid_to" IS NULL OR (length("hr_bonus_policy_members"."valid_to") = 10 AND "hr_bonus_policy_members"."valid_to" > "hr_bonus_policy_members"."valid_from"))),
	CONSTRAINT "ck_hr_bonus_policy_members_weight" CHECK("hr_bonus_policy_members"."weight_units" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_policy_members_start` ON `hr_bonus_policy_members` (`policy_version_id`,`employment_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_policy_members_employment` ON `hr_bonus_policy_members` (`employment_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `hr_bonus_policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`scope_id` text NOT NULL,
	`performance_kind` text NOT NULL,
	`revenue_kind` text NOT NULL,
	`rate_ppm` integer NOT NULL,
	`threshold_minor` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`policy_id`) REFERENCES `hr_bonus_policies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_policy_versions_number" CHECK("hr_bonus_policy_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_bonus_policy_versions_kind" CHECK("hr_bonus_policy_versions"."performance_kind" = 'scheduled_daily' AND "hr_bonus_policy_versions"."revenue_kind" = 'sales_amount'),
	CONSTRAINT "ck_hr_bonus_policy_versions_rate" CHECK("hr_bonus_policy_versions"."rate_ppm" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_hr_bonus_policy_versions_threshold" CHECK("hr_bonus_policy_versions"."threshold_minor" >= 0),
	CONSTRAINT "ck_hr_bonus_policy_versions_dates" CHECK(length("hr_bonus_policy_versions"."valid_from") = 10 AND ("hr_bonus_policy_versions"."valid_to" IS NULL OR (length("hr_bonus_policy_versions"."valid_to") = 10 AND "hr_bonus_policy_versions"."valid_to" > "hr_bonus_policy_versions"."valid_from")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_policy_versions_number` ON `hr_bonus_policy_versions` (`policy_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_policy_versions_scope_period` ON `hr_bonus_policy_versions` (`scope_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `hr_bonus_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_version_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`status` text DEFAULT 'calculated' NOT NULL,
	`pool_amount_minor` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_bonus_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_pools_dates" CHECK(length("hr_bonus_pools"."period_start") = 10 AND length("hr_bonus_pools"."period_end") = 10 AND "hr_bonus_pools"."period_end" > "hr_bonus_pools"."period_start"),
	CONSTRAINT "ck_hr_bonus_pools_version" CHECK("hr_bonus_pools"."calculation_version" > 0),
	CONSTRAINT "ck_hr_bonus_pools_status" CHECK("hr_bonus_pools"."status" IN ('calculated', 'approved', 'closed', 'failed')),
	CONSTRAINT "ck_hr_bonus_pools_amount" CHECK("hr_bonus_pools"."pool_amount_minor" >= 0),
	CONSTRAINT "ck_hr_bonus_pools_revision" CHECK("hr_bonus_pools"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_pools_version_period` ON `hr_bonus_pools` (`policy_version_id`,`period_start`,`period_end`,`calculation_version`);--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_pools_period` ON `hr_bonus_pools` (`period_start`,`period_end`,`status`);--> statement-breakpoint
CREATE TABLE `hr_bonus_revenue_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`bonus_pool_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`employment_id` text,
	`source_kind` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`source_start` text NOT NULL,
	`source_end` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`provenance_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`bonus_pool_id`) REFERENCES `hr_bonus_pools`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_revenue_snapshots_kind" CHECK("hr_bonus_revenue_snapshots"."source_kind" IN ('manual', 'report')),
	CONSTRAINT "ck_hr_bonus_revenue_snapshots_period" CHECK("hr_bonus_revenue_snapshots"."source_end" > "hr_bonus_revenue_snapshots"."source_start"),
	CONSTRAINT "ck_hr_bonus_revenue_snapshots_provenance" CHECK(length("hr_bonus_revenue_snapshots"."provenance_json") <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_revenue_snapshots_source` ON `hr_bonus_revenue_snapshots` (`bonus_pool_id`,`scope_id`,`employment_id`,`source_start`);--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_revenue_snapshots_period` ON `hr_bonus_revenue_snapshots` (`scope_id`,`source_start`,`source_end`);--> statement-breakpoint
CREATE TABLE `hr_payroll_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`period_key` text NOT NULL,
	`attendance_start` text NOT NULL,
	`attendance_end` text NOT NULL,
	`pay_date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_periods_key" CHECK("hr_payroll_periods"."period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_hr_payroll_periods_dates" CHECK(length("hr_payroll_periods"."attendance_start") = 10 AND length("hr_payroll_periods"."attendance_end") = 10 AND "hr_payroll_periods"."attendance_end" > "hr_payroll_periods"."attendance_start" AND length("hr_payroll_periods"."pay_date") = 10),
	CONSTRAINT "ck_hr_payroll_periods_status" CHECK("hr_payroll_periods"."status" IN ('open', 'closed')),
	CONSTRAINT "ck_hr_payroll_periods_revision" CHECK("hr_payroll_periods"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_periods_key` ON `hr_payroll_periods` (`period_key`);--> statement-breakpoint
CREATE TABLE `hr_payroll_run_employees` (
	`payroll_run_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`input_revision` integer NOT NULL,
	`status` text DEFAULT 'calculating' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`payroll_run_id`, `employment_id`),
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_run_employees_revision" CHECK("hr_payroll_run_employees"."input_revision" > 0),
	CONSTRAINT "ck_hr_payroll_run_employees_status" CHECK("hr_payroll_run_employees"."status" IN ('calculating', 'succeeded', 'failed')),
	CONSTRAINT "ck_hr_payroll_run_employees_error" CHECK(length("hr_payroll_run_employees"."last_error") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_run_employees_employment` ON `hr_payroll_run_employees` (`employment_id`,`payroll_run_id`);--> statement-breakpoint
CREATE TABLE `hr_payroll_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_period_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`request_id` text NOT NULL,
	`input_revision` integer NOT NULL,
	`engine_version` text NOT NULL,
	`status` text DEFAULT 'calculating' NOT NULL,
	`expected_count` integer DEFAULT 0 NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`approved_by` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_period_id`) REFERENCES `hr_payroll_periods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_runs_version" CHECK("hr_payroll_runs"."version_number" > 0),
	CONSTRAINT "ck_hr_payroll_runs_input_revision" CHECK("hr_payroll_runs"."input_revision" > 0),
	CONSTRAINT "ck_hr_payroll_runs_status" CHECK("hr_payroll_runs"."status" IN ('calculating', 'ready', 'approved', 'closed', 'failed')),
	CONSTRAINT "ck_hr_payroll_runs_counts" CHECK("hr_payroll_runs"."expected_count" >= 0 AND "hr_payroll_runs"."completed_count" BETWEEN 0 AND "hr_payroll_runs"."expected_count")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_runs_request` ON `hr_payroll_runs` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_runs_period_version` ON `hr_payroll_runs` (`payroll_period_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_runs_period_status` ON `hr_payroll_runs` (`payroll_period_id`,`status`);--> statement-breakpoint
CREATE TABLE `hr_payslip_compensation_links` (
	`payslip_id` text NOT NULL,
	`compensation_version_id` text NOT NULL,
	PRIMARY KEY(`payslip_id`, `compensation_version_id`),
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `hr_payslip_insurance_links` (
	`payslip_id` text NOT NULL,
	`insurance_version_id` text NOT NULL,
	PRIMARY KEY(`payslip_id`, `insurance_version_id`),
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`insurance_version_id`) REFERENCES `hr_insurance_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `hr_payslip_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`payslip_id` text NOT NULL,
	`line_key` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`quantity_seconds` integer,
	`explanation_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payslip_lines_key" CHECK(length(trim("hr_payslip_lines"."line_key")) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_payslip_lines_direction" CHECK("hr_payslip_lines"."direction" IN ('earning', 'deduction')),
	CONSTRAINT "ck_hr_payslip_lines_amount" CHECK("hr_payslip_lines"."amount_minor" >= 0),
	CONSTRAINT "ck_hr_payslip_lines_quantity" CHECK("hr_payslip_lines"."quantity_seconds" IS NULL OR "hr_payslip_lines"."quantity_seconds" >= 0),
	CONSTRAINT "ck_hr_payslip_lines_explanation" CHECK(length("hr_payslip_lines"."explanation_json") <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslip_lines_key` ON `hr_payslip_lines` (`payslip_id`,`line_key`);--> statement-breakpoint
CREATE TABLE `hr_payslips` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`employee_number` text NOT NULL,
	`employee_name` text NOT NULL,
	`earning_minor` integer NOT NULL,
	`deduction_minor` integer NOT NULL,
	`net_minor` integer NOT NULL,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payslips_amounts" CHECK("hr_payslips"."earning_minor" >= 0 AND "hr_payslips"."deduction_minor" >= 0 AND "hr_payslips"."net_minor" = "hr_payslips"."earning_minor" - "hr_payslips"."deduction_minor"),
	CONSTRAINT "ck_hr_payslips_employee_number" CHECK(length(trim("hr_payslips"."employee_number")) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslips_run_employment` ON `hr_payslips` (`payroll_run_id`,`employment_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payslips_employment` ON `hr_payslips` (`employment_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `hr_leave_requests` ADD COLUMN `pay_rate_ppm` integer DEFAULT 1000000 NOT NULL CHECK (`pay_rate_ppm` BETWEEN 0 AND 1000000);