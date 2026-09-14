CREATE TABLE `hr_leave_types` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `default_pay_rate_ppm` integer DEFAULT 1000000 NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_leave_types_name` CHECK(length(trim(`name`)) BETWEEN 1 AND 80),
  CONSTRAINT `ck_hr_leave_types_rate` CHECK(`default_pay_rate_ppm` BETWEEN 0 AND 1000000),
  CONSTRAINT `ck_hr_leave_types_active` CHECK(`active` IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_leave_types_name` ON `hr_leave_types` (`name`);
--> statement-breakpoint
CREATE TABLE `hr_monthly_leave_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `employment_id` text NOT NULL,
  `leave_type_id` text NOT NULL,
  `leave_date` text NOT NULL,
  `hours_half_units` integer NOT NULL,
  `pay_rate_ppm` integer NOT NULL,
  `deduction_amount` integer NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_by` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_monthly_leave_entries_date` CHECK(length(`leave_date`) = 10),
  CONSTRAINT `ck_hr_monthly_leave_entries_hours` CHECK(`hours_half_units` > 0),
  CONSTRAINT `ck_hr_monthly_leave_entries_rate` CHECK(`pay_rate_ppm` BETWEEN 0 AND 1000000),
  CONSTRAINT `ck_hr_monthly_leave_entries_deduction` CHECK(`deduction_amount` >= 0),
  CONSTRAINT `ck_hr_monthly_leave_entries_note` CHECK(length(`note`) <= 1000),
  CONSTRAINT `ck_hr_monthly_leave_entries_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_monthly_leave_entries_unique` ON `hr_monthly_leave_entries` (`employment_id`,`leave_type_id`,`leave_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_monthly_leave_entries_date` ON `hr_monthly_leave_entries` (`leave_date`,`employment_id`);
--> statement-breakpoint
CREATE TABLE `hr_monthly_hourly_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `employment_id` text NOT NULL,
  `work_date` text NOT NULL,
  `hours_half_units` integer DEFAULT 0 NOT NULL,
  `no_work` integer DEFAULT 0 NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_by` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_monthly_hourly_entries_date` CHECK(length(`work_date`) = 10),
  CONSTRAINT `ck_hr_monthly_hourly_entries_hours` CHECK(`hours_half_units` >= 0),
  CONSTRAINT `ck_hr_monthly_hourly_entries_no_work` CHECK(`no_work` IN (0, 1)),
  CONSTRAINT `ck_hr_monthly_hourly_entries_state` CHECK(`no_work` = 1 OR `hours_half_units` > 0),
  CONSTRAINT `ck_hr_monthly_hourly_entries_note` CHECK(length(`note`) <= 1000),
  CONSTRAINT `ck_hr_monthly_hourly_entries_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_monthly_hourly_entries_unique` ON `hr_monthly_hourly_entries` (`employment_id`,`work_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_monthly_hourly_entries_date` ON `hr_monthly_hourly_entries` (`work_date`,`employment_id`);
