CREATE TABLE `hr_payroll_adjustments` (
  `id` text PRIMARY KEY NOT NULL,
  `employment_id` text NOT NULL,
  `source_period_key` text NOT NULL,
  `effective_period_key` text NOT NULL,
  `reason` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_by` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_payroll_adjustments_source_period` CHECK(`source_period_key` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT `ck_hr_payroll_adjustments_effective_period` CHECK(`effective_period_key` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT `ck_hr_payroll_adjustments_reason` CHECK(length(trim(`reason`)) BETWEEN 1 AND 1000),
  CONSTRAINT `ck_hr_payroll_adjustments_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustments_effective` ON `hr_payroll_adjustments` (`effective_period_key`,`employment_id`);
--> statement-breakpoint
CREATE TABLE `hr_payroll_adjustment_items` (
  `id` text PRIMARY KEY NOT NULL,
  `adjustment_id` text NOT NULL,
  `item_name` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`adjustment_id`) REFERENCES `hr_payroll_adjustments`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_payroll_adjustment_items_name` CHECK(length(trim(`item_name`)) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustment_items_adjustment` ON `hr_payroll_adjustment_items` (`adjustment_id`);
