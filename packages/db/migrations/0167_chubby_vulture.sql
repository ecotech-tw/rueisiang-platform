CREATE TABLE `hr_special_workday_overtime_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_version_id` text NOT NULL,
	`from_half_hours` integer NOT NULL,
	`to_half_hours` integer,
	`rate_kind` text NOT NULL,
	`fixed_amount_minor` integer,
	`multiplier_ppm` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`rule_version_id`) REFERENCES `hr_special_workday_rule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_special_workday_overtime_rules_range" CHECK("hr_special_workday_overtime_rules"."from_half_hours" >= 1 AND ("hr_special_workday_overtime_rules"."to_half_hours" IS NULL OR "hr_special_workday_overtime_rules"."to_half_hours" >= "hr_special_workday_overtime_rules"."from_half_hours")),
	CONSTRAINT "ck_hr_special_workday_overtime_rules_rate" CHECK(("hr_special_workday_overtime_rules"."rate_kind" = 'fixed_hourly' AND "hr_special_workday_overtime_rules"."fixed_amount_minor" IS NOT NULL AND "hr_special_workday_overtime_rules"."fixed_amount_minor" >= 0 AND "hr_special_workday_overtime_rules"."multiplier_ppm" IS NULL) OR ("hr_special_workday_overtime_rules"."rate_kind" = 'multiplier' AND "hr_special_workday_overtime_rules"."fixed_amount_minor" IS NULL AND "hr_special_workday_overtime_rules"."multiplier_ppm" IS NOT NULL AND "hr_special_workday_overtime_rules"."multiplier_ppm" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_overtime_rules_version_from` ON `hr_special_workday_overtime_rules` (`rule_version_id`,`from_half_hours`);--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_overtime_rules_version` ON `hr_special_workday_overtime_rules` (`rule_version_id`);