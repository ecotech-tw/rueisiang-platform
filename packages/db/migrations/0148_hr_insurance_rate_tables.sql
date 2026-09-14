CREATE TABLE `hr_insurance_rate_tables` (
  `id` text PRIMARY KEY NOT NULL,
  `scheme` text NOT NULL,
  `year` integer NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `source_url` text NOT NULL,
  `fetched_at` text NOT NULL,
  `data_json` text NOT NULL,
  `created_by` text NOT NULL,
  `activated_at` text,
  `activated_by` text,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`activated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_insurance_rate_tables_scheme` CHECK(`scheme` IN ('labor', 'health')),
  CONSTRAINT `ck_hr_insurance_rate_tables_year` CHECK(`year` BETWEEN 1900 AND 9999),
  CONSTRAINT `ck_hr_insurance_rate_tables_status` CHECK(`status` IN ('draft', 'active', 'archived')),
  CONSTRAINT `ck_hr_insurance_rate_tables_url` CHECK(length(`source_url`) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_insurance_rate_tables_scheme_year_status` ON `hr_insurance_rate_tables` (`scheme`,`year`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_hr_insurance_rate_tables_year` ON `hr_insurance_rate_tables` (`year`,`scheme`);
