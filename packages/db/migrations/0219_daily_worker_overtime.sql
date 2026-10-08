ALTER TABLE `hr_worker_compensation_versions` ADD `overtime_rate_ppm` integer;--> statement-breakpoint
ALTER TABLE `hr_worker_compensation_versions` ADD `overtime_hourly_minor` integer;--> statement-breakpoint
ALTER TABLE `hr_payroll_worker_results` ADD `overtime_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_payroll_worker_results` ADD `overtime_seconds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_payroll_worker_results` ADD `overtime_explanation_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE TABLE `hr_worker_overtime_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_id` text NOT NULL REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
  `scope_id` text REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
  `requested_start` text NOT NULL,
  `requested_end` text NOT NULL,
  `actual_start` text,
  `actual_end` text,
  `settlement_kind` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `rate_ppm` integer DEFAULT 1333333 NOT NULL,
  `reason` text DEFAULT '' NOT NULL,
  `reviewed_by` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  `reviewed_at` text,
  `decision_reason` text DEFAULT '' NOT NULL,
  `created_by` text NOT NULL REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  CONSTRAINT `ck_hr_worker_overtime_requested_period` CHECK (`requested_end` > `requested_start`),
  CONSTRAINT `ck_hr_worker_overtime_actual_pair` CHECK ((`actual_start` IS NULL AND `actual_end` IS NULL) OR (`actual_start` IS NOT NULL AND `actual_end` IS NOT NULL AND `actual_end` > `actual_start`)),
  CONSTRAINT `ck_hr_worker_overtime_settlement` CHECK (`settlement_kind` IN ('pay', 'compensatory')),
  CONSTRAINT `ck_hr_worker_overtime_status` CHECK (`status` IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT `ck_hr_worker_overtime_rate` CHECK (`rate_ppm` BETWEEN 0 AND 10000000),
  CONSTRAINT `ck_hr_worker_overtime_reason` CHECK (length(`reason`) <= 1000),
  CONSTRAINT `ck_hr_worker_overtime_decision_reason` CHECK (length(`decision_reason`) <= 1000),
  CONSTRAINT `ck_hr_worker_overtime_revision` CHECK (`revision` > 0)
);--> statement-breakpoint
CREATE INDEX `idx_hr_worker_overtime_worker_start` ON `hr_worker_overtime_requests` (`worker_id`,`requested_start`);--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_compensation_versions_overtime_insert`
BEFORE INSERT ON `hr_worker_compensation_versions`
WHEN (NEW.`overtime_rate_ppm` IS NOT NULL AND (NEW.`overtime_rate_ppm` <= 0 OR NEW.`overtime_rate_ppm` > 10000000))
  OR (NEW.`overtime_hourly_minor` IS NOT NULL AND (NEW.`overtime_hourly_minor` <= 0 OR NEW.`overtime_hourly_minor` % 100 <> 0))
  OR (NEW.`overtime_rate_ppm` IS NOT NULL AND NEW.`overtime_hourly_minor` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'hr_worker_compensation_overtime_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_compensation_versions_overtime_update`
BEFORE UPDATE OF `overtime_rate_ppm`, `overtime_hourly_minor` ON `hr_worker_compensation_versions`
WHEN (NEW.`overtime_rate_ppm` IS NOT NULL AND (NEW.`overtime_rate_ppm` <= 0 OR NEW.`overtime_rate_ppm` > 10000000))
  OR (NEW.`overtime_hourly_minor` IS NOT NULL AND (NEW.`overtime_hourly_minor` <= 0 OR NEW.`overtime_hourly_minor` % 100 <> 0))
  OR (NEW.`overtime_rate_ppm` IS NOT NULL AND NEW.`overtime_hourly_minor` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'hr_worker_compensation_overtime_invalid');
END;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_worker_overtime_unique_request` ON `hr_worker_overtime_requests` (`worker_id`,`requested_start`,`requested_end`) WHERE `status` IN ('draft', 'pending', 'approved');--> statement-breakpoint
CREATE INDEX `idx_hr_worker_overtime_status` ON `hr_worker_overtime_requests` (`status`,`requested_start`);