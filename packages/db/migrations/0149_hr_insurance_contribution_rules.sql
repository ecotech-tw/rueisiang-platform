CREATE TABLE `hr_insurance_contribution_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `scheme` text NOT NULL,
  `valid_from` text NOT NULL,
  `valid_to` text,
  `employee_rate_ppm` integer NOT NULL,
  `employer_rate_ppm` integer NOT NULL,
  `dependent_rate_ppm` integer DEFAULT 1000000 NOT NULL,
  `source_kind` text NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_insurance_contribution_rules_dates` CHECK(length(`valid_from`) = 10 AND (`valid_to` IS NULL OR (length(`valid_to`) = 10 AND `valid_to` > `valid_from`))),
  CONSTRAINT `ck_hr_insurance_contribution_rules_rate` CHECK(`employee_rate_ppm` BETWEEN 0 AND 1000000 AND `employer_rate_ppm` BETWEEN 0 AND 1000000 AND `dependent_rate_ppm` BETWEEN 0 AND 1000000),
  CONSTRAINT `ck_hr_insurance_contribution_rules_source` CHECK(`source_kind` IN ('official', 'manual')),
  CONSTRAINT `ck_hr_insurance_contribution_rules_note` CHECK(length(`note`) <= 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_insurance_contribution_rules_period` ON `hr_insurance_contribution_rules` (`scheme`,`valid_from`,`valid_to`);
