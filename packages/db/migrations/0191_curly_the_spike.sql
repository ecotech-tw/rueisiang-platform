DROP INDEX `idx_hr_insurance_contribution_rules_period`;--> statement-breakpoint
ALTER TABLE `hr_insurance_contribution_rules` ADD `component` text;--> statement-breakpoint
CREATE INDEX `idx_hr_insurance_contribution_rules_period` ON `hr_insurance_contribution_rules` (`scheme`,`component`,`valid_from`,`valid_to`);