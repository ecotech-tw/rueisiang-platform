DROP INDEX `idx_hr_insurance_rate_tables_scheme_year_status`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_insurance_rate_tables_scheme_year_status` ON `hr_insurance_rate_tables` (`scheme`,`year`,`status`) WHERE `status` IN ('draft', 'active');
