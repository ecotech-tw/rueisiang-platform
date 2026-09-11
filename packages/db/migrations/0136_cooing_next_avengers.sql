CREATE TABLE `hr_bonus_performance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`employment_id` text,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`provenance_json` text DEFAULT '{}' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_performance_period" CHECK("hr_bonus_performance_snapshots"."period_end" > "hr_bonus_performance_snapshots"."period_start"),
	CONSTRAINT "ck_hr_bonus_performance_amount" CHECK("hr_bonus_performance_snapshots"."amount_minor" >= 0),
	CONSTRAINT "ck_hr_bonus_performance_kind" CHECK("hr_bonus_performance_snapshots"."source_kind" IN ('manual', 'report')),
	CONSTRAINT "ck_hr_bonus_performance_provenance" CHECK(length("hr_bonus_performance_snapshots"."provenance_json") <= 10000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_performance_scope_period` ON `hr_bonus_performance_snapshots` (`scope_id`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_performance_employment_period` ON `hr_bonus_performance_snapshots` (`employment_id`,`period_start`,`period_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_performance_source` ON `hr_bonus_performance_snapshots` (`scope_id`,`employment_id`,`period_start`,`period_end`,`source_ref`);--> statement-breakpoint
ALTER TABLE `hr_bonus_policy_versions` ADD `bonus_kind` text DEFAULT 'team_performance' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_bonus_policy_versions` ADD `performance_period` text DEFAULT 'current_month' NOT NULL;