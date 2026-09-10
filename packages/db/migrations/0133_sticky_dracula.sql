CREATE TABLE `hr_employment_attendance_settings` (
	`employment_id` text PRIMARY KEY NOT NULL,
	`attendance_mode` text DEFAULT 'general' NOT NULL,
	`primary_assignment_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_assignment_id`) REFERENCES `hr_employee_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employment_attendance_settings_mode" CHECK("hr_employment_attendance_settings"."attendance_mode" IN ('general', 'scheduled'))
);
--> statement-breakpoint
CREATE TABLE `hr_compensation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`pay_basis` text NOT NULL,
	`base_amount_minor` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_compensation_versions_number" CHECK("hr_compensation_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_compensation_versions_dates" CHECK(length("hr_compensation_versions"."valid_from") = 10 AND ("hr_compensation_versions"."valid_to" IS NULL OR (length("hr_compensation_versions"."valid_to") = 10 AND "hr_compensation_versions"."valid_to" > "hr_compensation_versions"."valid_from"))),
	CONSTRAINT "ck_hr_compensation_versions_basis" CHECK("hr_compensation_versions"."pay_basis" IN ('monthly', 'daily', 'hourly')),
	CONSTRAINT "ck_hr_compensation_versions_amount" CHECK("hr_compensation_versions"."base_amount_minor" >= 0),
	CONSTRAINT "ck_hr_compensation_versions_note" CHECK(length("hr_compensation_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_compensation_versions_number` ON `hr_compensation_versions` (`employment_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_compensation_versions_period` ON `hr_compensation_versions` (`employment_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `hr_insurance_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`scheme` text NOT NULL,
	`version_number` integer NOT NULL,
	`status` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`insured_amount_minor` integer NOT NULL,
	`dependent_count` integer DEFAULT 0 NOT NULL,
	`rate_year` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_insurance_versions_scheme" CHECK("hr_insurance_versions"."scheme" IN ('labor', 'health')),
	CONSTRAINT "ck_hr_insurance_versions_number" CHECK("hr_insurance_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_insurance_versions_status" CHECK("hr_insurance_versions"."status" IN ('enrolled', 'withdrawn')),
	CONSTRAINT "ck_hr_insurance_versions_dates" CHECK(length("hr_insurance_versions"."valid_from") = 10 AND ("hr_insurance_versions"."valid_to" IS NULL OR (length("hr_insurance_versions"."valid_to") = 10 AND "hr_insurance_versions"."valid_to" > "hr_insurance_versions"."valid_from"))),
	CONSTRAINT "ck_hr_insurance_versions_amount" CHECK("hr_insurance_versions"."insured_amount_minor" >= 0),
	CONSTRAINT "ck_hr_insurance_versions_dependents" CHECK("hr_insurance_versions"."dependent_count" BETWEEN 0 AND 3),
	CONSTRAINT "ck_hr_insurance_versions_year" CHECK("hr_insurance_versions"."rate_year" BETWEEN 1900 AND 9999),
	CONSTRAINT "ck_hr_insurance_versions_source" CHECK("hr_insurance_versions"."source_kind" IN ('official', 'manual')),
	CONSTRAINT "ck_hr_insurance_versions_source_url" CHECK(length("hr_insurance_versions"."source_url") <= 500),
	CONSTRAINT "ck_hr_insurance_versions_note" CHECK(length("hr_insurance_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_insurance_versions_number` ON `hr_insurance_versions` (`employment_id`,`scheme`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_insurance_versions_period` ON `hr_insurance_versions` (`employment_id`,`scheme`,`valid_from`);--> statement-breakpoint
CREATE TABLE `hr_leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`leave_type` text NOT NULL,
	`status` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`review_comment` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_requests_type" CHECK(length(trim("hr_leave_requests"."leave_type")) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_leave_requests_status" CHECK("hr_leave_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_leave_requests_dates" CHECK(length("hr_leave_requests"."starts_on") = 10 AND length("hr_leave_requests"."ends_on") = 10 AND "hr_leave_requests"."ends_on" > "hr_leave_requests"."starts_on"),
	CONSTRAINT "ck_hr_leave_requests_duration" CHECK("hr_leave_requests"."duration_minutes" > 0),
	CONSTRAINT "ck_hr_leave_requests_reason" CHECK(length("hr_leave_requests"."reason") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_period` ON `hr_leave_requests` (`employment_id`,`starts_on`);