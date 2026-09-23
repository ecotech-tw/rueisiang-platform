CREATE TABLE IF NOT EXISTS `hr_annual_leave_brackets` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_version_id` text NOT NULL,
	`min_service_months` integer NOT NULL,
	`max_service_months` integer,
	`entitled_days` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_annual_leave_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_bracket_range" CHECK("hr_annual_leave_brackets"."min_service_months" >= 6 AND ("hr_annual_leave_brackets"."max_service_months" IS NULL OR "hr_annual_leave_brackets"."max_service_months" > "hr_annual_leave_brackets"."min_service_months")),
	CONSTRAINT "ck_hr_annual_leave_bracket_days" CHECK("hr_annual_leave_brackets"."entitled_days" > 0 AND "hr_annual_leave_brackets"."entitled_days" <= 30),
	CONSTRAINT "ck_hr_annual_leave_bracket_label" CHECK(length("hr_annual_leave_brackets"."label") <= 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_hr_annual_leave_bracket_start` ON `hr_annual_leave_brackets` (`policy_version_id`,`min_service_months`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hr_annual_leave_bracket_policy` ON `hr_annual_leave_brackets` (`policy_version_id`,`min_service_months`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hr_annual_leave_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`policy_version_id` text NOT NULL,
	`bracket_id` text NOT NULL,
	`service_months` integer NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`entitled_half_hours` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`settled_at` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_annual_leave_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bracket_id`) REFERENCES `hr_annual_leave_brackets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_entitlement_dates" CHECK(length("hr_annual_leave_entitlements"."period_start") = 10 AND length("hr_annual_leave_entitlements"."period_end") = 10 AND "hr_annual_leave_entitlements"."period_end" > "hr_annual_leave_entitlements"."period_start"),
	CONSTRAINT "ck_hr_annual_leave_entitlement_service" CHECK("hr_annual_leave_entitlements"."service_months" >= 6),
	CONSTRAINT "ck_hr_annual_leave_entitlement_amount" CHECK("hr_annual_leave_entitlements"."entitled_half_hours" > 0),
	CONSTRAINT "ck_hr_annual_leave_entitlement_status" CHECK("hr_annual_leave_entitlements"."status" IN ('open', 'settled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_hr_annual_leave_entitlement_period` ON `hr_annual_leave_entitlements` (`employment_id`,`period_start`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hr_annual_leave_entitlement_employee` ON `hr_annual_leave_entitlements` (`employment_id`,`period_end`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hr_annual_leave_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`entitlement_id` text NOT NULL,
	`entry_kind` text NOT NULL,
	`delta_half_hours` integer NOT NULL,
	`source_key` text NOT NULL,
	`leave_request_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entitlement_id`) REFERENCES `hr_annual_leave_entitlements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_request_id`) REFERENCES `hr_leave_requests`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_ledger_kind" CHECK("hr_annual_leave_ledger"."entry_kind" IN ('grant', 'leave_request', 'manual_adjustment', 'settlement', 'settlement_reversal')),
	CONSTRAINT "ck_hr_annual_leave_ledger_delta" CHECK("hr_annual_leave_ledger"."delta_half_hours" <> 0),
	CONSTRAINT "ck_hr_annual_leave_ledger_note" CHECK(length("hr_annual_leave_ledger"."note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_hr_annual_leave_ledger_source` ON `hr_annual_leave_ledger` (`source_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hr_annual_leave_ledger_entitlement` ON `hr_annual_leave_ledger` (`entitlement_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hr_annual_leave_policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_key` text DEFAULT 'annual_leave' NOT NULL,
	`version_number` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`basis` text DEFAULT 'anniversary' NOT NULL,
	`daily_minutes` integer DEFAULT 480 NOT NULL,
	`minimum_unit_minutes` integer DEFAULT 30 NOT NULL,
	`carryover_allowed` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_policy_dates" CHECK(length("hr_annual_leave_policy_versions"."valid_from") = 10 AND ("hr_annual_leave_policy_versions"."valid_to" IS NULL OR (length("hr_annual_leave_policy_versions"."valid_to") = 10 AND "hr_annual_leave_policy_versions"."valid_to" > "hr_annual_leave_policy_versions"."valid_from"))),
	CONSTRAINT "ck_hr_annual_leave_policy_basis" CHECK("hr_annual_leave_policy_versions"."basis" = 'anniversary'),
	CONSTRAINT "ck_hr_annual_leave_policy_minutes" CHECK("hr_annual_leave_policy_versions"."daily_minutes" > 0 AND "hr_annual_leave_policy_versions"."daily_minutes" % "hr_annual_leave_policy_versions"."minimum_unit_minutes" = 0 AND "hr_annual_leave_policy_versions"."minimum_unit_minutes" = 30),
	CONSTRAINT "ck_hr_annual_leave_policy_carryover" CHECK("hr_annual_leave_policy_versions"."carryover_allowed" IN (0, 1)),
	CONSTRAINT "ck_hr_annual_leave_policy_note" CHECK(length("hr_annual_leave_policy_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_hr_annual_leave_policy_version` ON `hr_annual_leave_policy_versions` (`policy_key`,`version_number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hr_annual_leave_policy_period` ON `hr_annual_leave_policy_versions` (`policy_key`,`valid_from`);--> statement-breakpoint
ALTER TABLE `hr_leave_requests` ADD `leave_type_id` text REFERENCES hr_leave_types(id);--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_leave_type` ON `hr_leave_requests` (`leave_type_id`);--> statement-breakpoint
ALTER TABLE `hr_leave_types` ADD `leave_kind` text DEFAULT 'other' NOT NULL;