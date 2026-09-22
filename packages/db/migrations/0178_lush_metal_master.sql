/* These tables reference parents recreated below. Keep their rows in unreferenced staging tables,
 * then recreate the child tables after all referenced parents have their new employment FK. */
CREATE TABLE `__hr_compensation_items_backup` AS SELECT * FROM `hr_compensation_items`;--> statement-breakpoint
CREATE TABLE `__hr_payroll_run_employees_backup` AS SELECT * FROM `hr_payroll_run_employees`;--> statement-breakpoint
CREATE TABLE `__hr_payslip_compensation_links_backup` AS SELECT * FROM `hr_payslip_compensation_links`;--> statement-breakpoint
CREATE TABLE `__hr_payslip_insurance_links_backup` AS SELECT * FROM `hr_payslip_insurance_links`;--> statement-breakpoint
CREATE TABLE `__hr_payslip_lines_backup` AS SELECT * FROM `hr_payslip_lines`;--> statement-breakpoint
DROP TABLE `hr_payslip_compensation_links`;--> statement-breakpoint
DROP TABLE `hr_payslip_insurance_links`;--> statement-breakpoint
DROP TABLE `hr_payslip_lines`;--> statement-breakpoint
DROP TABLE `hr_compensation_items`;--> statement-breakpoint
DROP TABLE `hr_payroll_run_employees`;--> statement-breakpoint
CREATE TABLE `__new_hr_employee_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_scopes_dates" CHECK(length("__new_hr_employee_scopes"."valid_from") = 10 AND ("__new_hr_employee_scopes"."valid_to" IS NULL OR (length("__new_hr_employee_scopes"."valid_to") = 10 AND "__new_hr_employee_scopes"."valid_to" > "__new_hr_employee_scopes"."valid_from"))),
	CONSTRAINT "ck_hr_employee_scopes_revision" CHECK("__new_hr_employee_scopes"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_employee_scopes`("id", "employment_id", "scope_id", "valid_from", "valid_to", "revision", "created_at", "updated_at") SELECT "id", "employment_id", "scope_id", "valid_from", "valid_to", "revision", "created_at", "updated_at" FROM `hr_employee_scopes`;--> statement-breakpoint
DROP TABLE `hr_employee_scopes`;--> statement-breakpoint
ALTER TABLE `__new_hr_employee_scopes` RENAME TO `hr_employee_scopes`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_scopes_start` ON `hr_employee_scopes` (`employment_id`,`scope_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_hr_employee_scopes_scope` ON `hr_employee_scopes` (`scope_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `__new_hr_clock_events` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_user_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`attendance_location_id` text,
	`scope_id` text,
	`source_kind` text DEFAULT 'portal' NOT NULL,
	`idempotency_key` text NOT NULL,
	`correction_request_id` text,
	`event_kind` text NOT NULL,
	`latitude_e7` integer,
	`longitude_e7` integer,
	`distance_meters` integer,
	`location_name_snapshot` text DEFAULT '' NOT NULL,
	`scope_name_snapshot` text DEFAULT '' NOT NULL,
	`recorded_by` text,
	`manual_reason` text DEFAULT '' NOT NULL,
	`time_anomaly_kind` text,
	`expected_start_minute` integer,
	`expected_end_minute` integer,
	`tolerance_minutes` integer,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attendance_location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_clock_events_source" CHECK("__new_hr_clock_events"."source_kind" IN ('portal', 'rfid', 'line', 'manual')),
	CONSTRAINT "ck_hr_clock_events_kind" CHECK("__new_hr_clock_events"."event_kind" IN ('clock_in', 'clock_out')),
	CONSTRAINT "ck_hr_clock_events_coordinate_pair" CHECK(("__new_hr_clock_events"."latitude_e7" IS NULL AND "__new_hr_clock_events"."longitude_e7" IS NULL) OR ("__new_hr_clock_events"."latitude_e7" IS NOT NULL AND "__new_hr_clock_events"."longitude_e7" IS NOT NULL)),
	CONSTRAINT "ck_hr_clock_events_latitude" CHECK("__new_hr_clock_events"."latitude_e7" IS NULL OR "__new_hr_clock_events"."latitude_e7" BETWEEN -900000000 AND 900000000),
	CONSTRAINT "ck_hr_clock_events_longitude" CHECK("__new_hr_clock_events"."longitude_e7" IS NULL OR "__new_hr_clock_events"."longitude_e7" BETWEEN -1800000000 AND 1800000000),
	CONSTRAINT "ck_hr_clock_events_distance" CHECK("__new_hr_clock_events"."distance_meters" IS NULL OR "__new_hr_clock_events"."distance_meters" >= 0),
	CONSTRAINT "ck_hr_clock_events_anomaly" CHECK("__new_hr_clock_events"."time_anomaly_kind" IS NULL OR "__new_hr_clock_events"."time_anomaly_kind" IN ('early', 'late', 'early_leave', 'overtime', 'rest_day')),
	CONSTRAINT "ck_hr_clock_events_expected_start" CHECK("__new_hr_clock_events"."expected_start_minute" IS NULL OR "__new_hr_clock_events"."expected_start_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "ck_hr_clock_events_expected_end" CHECK("__new_hr_clock_events"."expected_end_minute" IS NULL OR "__new_hr_clock_events"."expected_end_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "ck_hr_clock_events_tolerance" CHECK("__new_hr_clock_events"."tolerance_minutes" IS NULL OR "__new_hr_clock_events"."tolerance_minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
INSERT INTO `__new_hr_clock_events`("id", "employee_user_id", "employment_id", "attendance_location_id", "scope_id", "source_kind", "idempotency_key", "correction_request_id", "event_kind", "latitude_e7", "longitude_e7", "distance_meters", "location_name_snapshot", "scope_name_snapshot", "recorded_by", "manual_reason", "time_anomaly_kind", "expected_start_minute", "expected_end_minute", "tolerance_minutes", "occurred_at", "received_at") SELECT "id", "employee_user_id", "employment_id", "attendance_location_id", "scope_id", "source_kind", "idempotency_key", "correction_request_id", "event_kind", "latitude_e7", "longitude_e7", "distance_meters", "location_name_snapshot", "scope_name_snapshot", "recorded_by", "manual_reason", "time_anomaly_kind", "expected_start_minute", "expected_end_minute", "tolerance_minutes", "occurred_at", "received_at" FROM `hr_clock_events`;--> statement-breakpoint
DROP TABLE `hr_clock_events`;--> statement-breakpoint
ALTER TABLE `__new_hr_clock_events` RENAME TO `hr_clock_events`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_clock_events_idempotency` ON `hr_clock_events` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_clock_events_correction_request` ON `hr_clock_events` (`correction_request_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_clock_events_employee_occurred` ON `hr_clock_events` (`employee_user_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `__new_hr_employee_attendance_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`location_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_attendance_locations_dates" CHECK(length("__new_hr_employee_attendance_locations"."valid_from") = 10 AND ("__new_hr_employee_attendance_locations"."valid_to" IS NULL OR (length("__new_hr_employee_attendance_locations"."valid_to") = 10 AND "__new_hr_employee_attendance_locations"."valid_to" > "__new_hr_employee_attendance_locations"."valid_from"))),
	CONSTRAINT "ck_hr_employee_attendance_locations_revision" CHECK("__new_hr_employee_attendance_locations"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_employee_attendance_locations`("id", "employment_id", "location_id", "valid_from", "valid_to", "created_at", "updated_at", "revision") SELECT "id", "employment_id", "location_id", "valid_from", "valid_to", "created_at", "updated_at", "revision" FROM `hr_employee_attendance_locations`;--> statement-breakpoint
DROP TABLE `hr_employee_attendance_locations`;--> statement-breakpoint
ALTER TABLE `__new_hr_employee_attendance_locations` RENAME TO `hr_employee_attendance_locations`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_attendance_locations_start` ON `hr_employee_attendance_locations` (`employment_id`,`location_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_hr_employee_attendance_locations_location` ON `hr_employee_attendance_locations` (`location_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `__new_hr_employment_attendance_settings` (
	`employment_id` text PRIMARY KEY NOT NULL,
	`attendance_mode` text DEFAULT 'general' NOT NULL,
	`monthly_rest_days` integer,
	`primary_assignment_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_assignment_id`) REFERENCES `hr_employee_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employment_attendance_settings_mode" CHECK("__new_hr_employment_attendance_settings"."attendance_mode" IN ('general', 'scheduled')),
	CONSTRAINT "ck_hr_employment_attendance_settings_rest_days" CHECK("__new_hr_employment_attendance_settings"."monthly_rest_days" IS NULL OR "__new_hr_employment_attendance_settings"."monthly_rest_days" BETWEEN 0 AND 31)
);
--> statement-breakpoint
INSERT INTO `__new_hr_employment_attendance_settings`("employment_id", "attendance_mode", "monthly_rest_days", "primary_assignment_id", "updated_at") SELECT "employment_id", "attendance_mode", "monthly_rest_days", "primary_assignment_id", "updated_at" FROM `hr_employment_attendance_settings`;--> statement-breakpoint
DROP TABLE `hr_employment_attendance_settings`;--> statement-breakpoint
ALTER TABLE `__new_hr_employment_attendance_settings` RENAME TO `hr_employment_attendance_settings`;--> statement-breakpoint
CREATE TABLE `__new_hr_form_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_user_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`form_kind` text DEFAULT 'clock_correction' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`correction_date` text NOT NULL,
	`requested_event_kind` text NOT NULL,
	`requested_at` text NOT NULL,
	`reason` text NOT NULL,
	`approver_user_id` text,
	`submitted_at` text,
	`reviewed_at` text,
	`review_comment` text,
	`corrected_clock_event_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approver_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_form_requests_kind" CHECK("__new_hr_form_requests"."form_kind" = 'clock_correction'),
	CONSTRAINT "ck_hr_form_requests_status" CHECK("__new_hr_form_requests"."status" IN ('draft', 'pending', 'approved', 'rejected')),
	CONSTRAINT "ck_hr_form_requests_event_kind" CHECK("__new_hr_form_requests"."requested_event_kind" IN ('clock_in', 'clock_out')),
	CONSTRAINT "ck_hr_form_requests_date" CHECK(length("__new_hr_form_requests"."correction_date") = 10),
	CONSTRAINT "ck_hr_form_requests_reason" CHECK(length(trim("__new_hr_form_requests"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_form_requests`("id", "employee_user_id", "employment_id", "form_kind", "status", "correction_date", "requested_event_kind", "requested_at", "reason", "approver_user_id", "submitted_at", "reviewed_at", "review_comment", "corrected_clock_event_id", "created_at", "updated_at") SELECT "id", "employee_user_id", "employment_id", "form_kind", "status", "correction_date", "requested_event_kind", "requested_at", "reason", "approver_user_id", "submitted_at", "reviewed_at", "review_comment", "corrected_clock_event_id", "created_at", "updated_at" FROM `hr_form_requests`;--> statement-breakpoint
DROP TABLE `hr_form_requests`;--> statement-breakpoint
ALTER TABLE `__new_hr_form_requests` RENAME TO `hr_form_requests`;--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_employee_created` ON `hr_form_requests` (`employee_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_approver_status` ON `hr_form_requests` (`approver_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_corrected_event` ON `hr_form_requests` (`corrected_clock_event_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_compensation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`pay_basis` text NOT NULL,
	`base_amount_minor` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`voided_at` text,
	`voided_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_compensation_versions_number" CHECK("__new_hr_compensation_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_compensation_versions_dates" CHECK(length("__new_hr_compensation_versions"."valid_from") = 10 AND ("__new_hr_compensation_versions"."valid_to" IS NULL OR (length("__new_hr_compensation_versions"."valid_to") = 10 AND "__new_hr_compensation_versions"."valid_to" > "__new_hr_compensation_versions"."valid_from"))),
	CONSTRAINT "ck_hr_compensation_versions_basis" CHECK("__new_hr_compensation_versions"."pay_basis" IN ('monthly', 'daily', 'hourly')),
	CONSTRAINT "ck_hr_compensation_versions_amount" CHECK("__new_hr_compensation_versions"."base_amount_minor" >= 0),
	CONSTRAINT "ck_hr_compensation_versions_note" CHECK(length("__new_hr_compensation_versions"."note") <= 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_compensation_versions`("id", "employment_id", "version_number", "valid_from", "valid_to", "pay_basis", "base_amount_minor", "note", "voided_at", "voided_by", "created_at", "created_by") SELECT "id", "employment_id", "version_number", "valid_from", "valid_to", "pay_basis", "base_amount_minor", "note", "voided_at", "voided_by", "created_at", "created_by" FROM `hr_compensation_versions`;--> statement-breakpoint
DROP TABLE `hr_compensation_versions`;--> statement-breakpoint
ALTER TABLE `__new_hr_compensation_versions` RENAME TO `hr_compensation_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_compensation_versions_number` ON `hr_compensation_versions` (`employment_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_compensation_versions_period` ON `hr_compensation_versions` (`employment_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `__new_hr_insurance_versions` (
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
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_insurance_versions_scheme" CHECK("__new_hr_insurance_versions"."scheme" IN ('labor', 'health')),
	CONSTRAINT "ck_hr_insurance_versions_number" CHECK("__new_hr_insurance_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_insurance_versions_status" CHECK("__new_hr_insurance_versions"."status" IN ('enrolled', 'withdrawn')),
	CONSTRAINT "ck_hr_insurance_versions_dates" CHECK(length("__new_hr_insurance_versions"."valid_from") = 10 AND ("__new_hr_insurance_versions"."valid_to" IS NULL OR (length("__new_hr_insurance_versions"."valid_to") = 10 AND "__new_hr_insurance_versions"."valid_to" > "__new_hr_insurance_versions"."valid_from"))),
	CONSTRAINT "ck_hr_insurance_versions_amount" CHECK("__new_hr_insurance_versions"."insured_amount_minor" >= 0),
	CONSTRAINT "ck_hr_insurance_versions_dependents" CHECK("__new_hr_insurance_versions"."dependent_count" BETWEEN 0 AND 3),
	CONSTRAINT "ck_hr_insurance_versions_year" CHECK("__new_hr_insurance_versions"."rate_year" BETWEEN 1900 AND 9999),
	CONSTRAINT "ck_hr_insurance_versions_source" CHECK("__new_hr_insurance_versions"."source_kind" IN ('official', 'manual')),
	CONSTRAINT "ck_hr_insurance_versions_source_url" CHECK(length("__new_hr_insurance_versions"."source_url") <= 500),
	CONSTRAINT "ck_hr_insurance_versions_note" CHECK(length("__new_hr_insurance_versions"."note") <= 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_insurance_versions`("id", "employment_id", "scheme", "version_number", "status", "valid_from", "valid_to", "insured_amount_minor", "dependent_count", "rate_year", "source_kind", "source_url", "note", "created_at", "created_by") SELECT "id", "employment_id", "scheme", "version_number", "status", "valid_from", "valid_to", "insured_amount_minor", "dependent_count", "rate_year", "source_kind", "source_url", "note", "created_at", "created_by" FROM `hr_insurance_versions`;--> statement-breakpoint
DROP TABLE `hr_insurance_versions`;--> statement-breakpoint
ALTER TABLE `__new_hr_insurance_versions` RENAME TO `hr_insurance_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_insurance_versions_number` ON `hr_insurance_versions` (`employment_id`,`scheme`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_insurance_versions_period` ON `hr_insurance_versions` (`employment_id`,`scheme`,`valid_from`);--> statement-breakpoint
CREATE TABLE `__new_hr_leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`leave_type` text NOT NULL,
	`status` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`pay_rate_ppm` integer DEFAULT 1000000 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`review_comment` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_requests_type" CHECK(length(trim("__new_hr_leave_requests"."leave_type")) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_leave_requests_status" CHECK("__new_hr_leave_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_leave_requests_dates" CHECK(length("__new_hr_leave_requests"."starts_on") = 10 AND length("__new_hr_leave_requests"."ends_on") = 10 AND "__new_hr_leave_requests"."ends_on" > "__new_hr_leave_requests"."starts_on"),
	CONSTRAINT "ck_hr_leave_requests_duration" CHECK("__new_hr_leave_requests"."duration_minutes" > 0),
	CONSTRAINT "ck_hr_leave_requests_pay_rate" CHECK("__new_hr_leave_requests"."pay_rate_ppm" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_hr_leave_requests_reason" CHECK(length("__new_hr_leave_requests"."reason") <= 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_leave_requests`("id", "employment_id", "leave_type", "status", "starts_on", "ends_on", "duration_minutes", "pay_rate_ppm", "reason", "reviewed_by", "reviewed_at", "review_comment", "created_at", "created_by") SELECT "id", "employment_id", "leave_type", "status", "starts_on", "ends_on", "duration_minutes", "pay_rate_ppm", "reason", "reviewed_by", "reviewed_at", "review_comment", "created_at", "created_by" FROM `hr_leave_requests`;--> statement-breakpoint
DROP TABLE `hr_leave_requests`;--> statement-breakpoint
ALTER TABLE `__new_hr_leave_requests` RENAME TO `hr_leave_requests`;--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_period` ON `hr_leave_requests` (`employment_id`,`starts_on`);--> statement-breakpoint
CREATE TABLE `__new_hr_monthly_hourly_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`work_date` text NOT NULL,
	`hours_half_units` integer DEFAULT 0 NOT NULL,
	`no_work` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_monthly_hourly_entries_date" CHECK(length("__new_hr_monthly_hourly_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_monthly_hourly_entries_hours" CHECK("__new_hr_monthly_hourly_entries"."hours_half_units" >= 0),
	CONSTRAINT "ck_hr_monthly_hourly_entries_no_work" CHECK("__new_hr_monthly_hourly_entries"."no_work" IN (0, 1)),
	CONSTRAINT "ck_hr_monthly_hourly_entries_state" CHECK("__new_hr_monthly_hourly_entries"."no_work" = 1 OR "__new_hr_monthly_hourly_entries"."hours_half_units" > 0),
	CONSTRAINT "ck_hr_monthly_hourly_entries_note" CHECK(length("__new_hr_monthly_hourly_entries"."note") <= 1000),
	CONSTRAINT "ck_hr_monthly_hourly_entries_revision" CHECK("__new_hr_monthly_hourly_entries"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_monthly_hourly_entries`("id", "employment_id", "work_date", "hours_half_units", "no_work", "note", "created_by", "created_at", "updated_by", "updated_at", "revision") SELECT "id", "employment_id", "work_date", "hours_half_units", "no_work", "note", "created_by", "created_at", "updated_by", "updated_at", "revision" FROM `hr_monthly_hourly_entries`;--> statement-breakpoint
DROP TABLE `hr_monthly_hourly_entries`;--> statement-breakpoint
ALTER TABLE `__new_hr_monthly_hourly_entries` RENAME TO `hr_monthly_hourly_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_monthly_hourly_entries_unique` ON `hr_monthly_hourly_entries` (`employment_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_monthly_hourly_entries_date` ON `hr_monthly_hourly_entries` (`work_date`,`employment_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_monthly_leave_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`leave_type_id` text NOT NULL,
	`leave_date` text NOT NULL,
	`hours_half_units` integer NOT NULL,
	`pay_rate_ppm` integer NOT NULL,
	`deduction_amount` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_monthly_leave_entries_date" CHECK(length("__new_hr_monthly_leave_entries"."leave_date") = 10),
	CONSTRAINT "ck_hr_monthly_leave_entries_hours" CHECK("__new_hr_monthly_leave_entries"."hours_half_units" > 0),
	CONSTRAINT "ck_hr_monthly_leave_entries_rate" CHECK("__new_hr_monthly_leave_entries"."pay_rate_ppm" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_hr_monthly_leave_entries_deduction" CHECK("__new_hr_monthly_leave_entries"."deduction_amount" >= 0),
	CONSTRAINT "ck_hr_monthly_leave_entries_note" CHECK(length("__new_hr_monthly_leave_entries"."note") <= 1000),
	CONSTRAINT "ck_hr_monthly_leave_entries_revision" CHECK("__new_hr_monthly_leave_entries"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_monthly_leave_entries`("id", "employment_id", "leave_type_id", "leave_date", "hours_half_units", "pay_rate_ppm", "deduction_amount", "note", "created_by", "created_at", "updated_by", "updated_at", "revision") SELECT "id", "employment_id", "leave_type_id", "leave_date", "hours_half_units", "pay_rate_ppm", "deduction_amount", "note", "created_by", "created_at", "updated_by", "updated_at", "revision" FROM `hr_monthly_leave_entries`;--> statement-breakpoint
DROP TABLE `hr_monthly_leave_entries`;--> statement-breakpoint
ALTER TABLE `__new_hr_monthly_leave_entries` RENAME TO `hr_monthly_leave_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_monthly_leave_entries_unique` ON `hr_monthly_leave_entries` (`employment_id`,`leave_type_id`,`leave_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_monthly_leave_entries_date` ON `hr_monthly_leave_entries` (`leave_date`,`employment_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_overtime_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text,
	`requested_start` text NOT NULL,
	`requested_end` text NOT NULL,
	`actual_start` text,
	`actual_end` text,
	`settlement_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rate_ppm` integer DEFAULT 1333333 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`decision_reason` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_overtime_requested_period" CHECK("__new_hr_overtime_requests"."requested_end" > "__new_hr_overtime_requests"."requested_start"),
	CONSTRAINT "ck_hr_overtime_actual_pair" CHECK(("__new_hr_overtime_requests"."actual_start" IS NULL AND "__new_hr_overtime_requests"."actual_end" IS NULL) OR ("__new_hr_overtime_requests"."actual_start" IS NOT NULL AND "__new_hr_overtime_requests"."actual_end" IS NOT NULL AND "__new_hr_overtime_requests"."actual_end" > "__new_hr_overtime_requests"."actual_start")),
	CONSTRAINT "ck_hr_overtime_settlement" CHECK("__new_hr_overtime_requests"."settlement_kind" IN ('pay', 'compensatory')),
	CONSTRAINT "ck_hr_overtime_status" CHECK("__new_hr_overtime_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_overtime_rate" CHECK("__new_hr_overtime_requests"."rate_ppm" BETWEEN 0 AND 10000000),
	CONSTRAINT "ck_hr_overtime_reason" CHECK(length("__new_hr_overtime_requests"."reason") <= 1000),
	CONSTRAINT "ck_hr_overtime_decision_reason" CHECK(length("__new_hr_overtime_requests"."decision_reason") <= 1000),
	CONSTRAINT "ck_hr_overtime_revision" CHECK("__new_hr_overtime_requests"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_overtime_requests`("id", "employment_id", "scope_id", "requested_start", "requested_end", "actual_start", "actual_end", "settlement_kind", "status", "rate_ppm", "reason", "reviewed_by", "reviewed_at", "decision_reason", "created_by", "created_at", "updated_at", "revision") SELECT "id", "employment_id", "scope_id", "requested_start", "requested_end", "actual_start", "actual_end", "settlement_kind", "status", "rate_ppm", "reason", "reviewed_by", "reviewed_at", "decision_reason", "created_by", "created_at", "updated_at", "revision" FROM `hr_overtime_requests`;--> statement-breakpoint
DROP TABLE `hr_overtime_requests`;--> statement-breakpoint
ALTER TABLE `__new_hr_overtime_requests` RENAME TO `hr_overtime_requests`;--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_employment_start` ON `hr_overtime_requests` (`employment_id`,`requested_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_overtime_unique_request` ON `hr_overtime_requests` (`employment_id`,`requested_start`,`requested_end`);--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_status` ON `hr_overtime_requests` (`status`,`requested_start`);--> statement-breakpoint
CREATE TABLE `__new_hr_schedule_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_version_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`shift_version_id` text NOT NULL,
	`work_date` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`standard_minutes` integer DEFAULT 480 NOT NULL,
	`break_minutes` integer DEFAULT 60 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`schedule_version_id`) REFERENCES `hr_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_version_id`) REFERENCES `hr_shift_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_entries_date" CHECK(length("__new_hr_schedule_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_schedule_entries_period" CHECK("__new_hr_schedule_entries"."ends_at" > "__new_hr_schedule_entries"."starts_at"),
	CONSTRAINT "ck_hr_schedule_entries_standard" CHECK("__new_hr_schedule_entries"."standard_minutes" BETWEEN 0 AND 1440),
	CONSTRAINT "ck_hr_schedule_entries_break" CHECK("__new_hr_schedule_entries"."break_minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
INSERT INTO `__new_hr_schedule_entries`("id", "schedule_version_id", "employment_id", "scope_id", "shift_version_id", "work_date", "starts_at", "ends_at", "standard_minutes", "break_minutes", "created_by", "created_at") SELECT "id", "schedule_version_id", "employment_id", "scope_id", "shift_version_id", "work_date", "starts_at", "ends_at", "standard_minutes", "break_minutes", "created_by", "created_at" FROM `hr_schedule_entries`;--> statement-breakpoint
DROP TABLE `hr_schedule_entries`;--> statement-breakpoint
ALTER TABLE `__new_hr_schedule_entries` RENAME TO `hr_schedule_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_entries_unique` ON `hr_schedule_entries` (`schedule_version_id`,`employment_id`,`work_date`,`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_employment_date` ON `hr_schedule_entries` (`employment_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_scope_date` ON `hr_schedule_entries` (`scope_id`,`work_date`);--> statement-breakpoint
CREATE TABLE `__new_hr_special_workday_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_version_id` text NOT NULL,
	`employment_id` text,
	`worker_id` text,
	`work_date` text NOT NULL,
	`rule_name_snapshot` text NOT NULL,
	`wage_kind_snapshot` text NOT NULL,
	`fixed_amount_minor_snapshot` integer,
	`multiplier_ppm_snapshot` integer,
	`work_source_snapshot` text NOT NULL,
	`allowance_snapshot_json` text DEFAULT '[]' NOT NULL,
	`allowance_quantity` integer DEFAULT 0 NOT NULL,
	`applied_by` text NOT NULL,
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`rule_version_id`) REFERENCES `hr_special_workday_rule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_special_workday_assignments_target" CHECK(("__new_hr_special_workday_assignments"."employment_id" IS NOT NULL AND "__new_hr_special_workday_assignments"."worker_id" IS NULL) OR ("__new_hr_special_workday_assignments"."employment_id" IS NULL AND "__new_hr_special_workday_assignments"."worker_id" IS NOT NULL)),
	CONSTRAINT "ck_hr_special_workday_assignments_date" CHECK(length("__new_hr_special_workday_assignments"."work_date") = 10),
	CONSTRAINT "ck_hr_special_workday_assignments_quantity" CHECK("__new_hr_special_workday_assignments"."allowance_quantity" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_special_workday_assignments`("id", "rule_version_id", "employment_id", "worker_id", "work_date", "rule_name_snapshot", "wage_kind_snapshot", "fixed_amount_minor_snapshot", "multiplier_ppm_snapshot", "work_source_snapshot", "allowance_snapshot_json", "allowance_quantity", "applied_by", "applied_at") SELECT "id", "rule_version_id", "employment_id", "worker_id", "work_date", "rule_name_snapshot", "wage_kind_snapshot", "fixed_amount_minor_snapshot", "multiplier_ppm_snapshot", "work_source_snapshot", "allowance_snapshot_json", "allowance_quantity", "applied_by", "applied_at" FROM `hr_special_workday_assignments`;--> statement-breakpoint
DROP TABLE `hr_special_workday_assignments`;--> statement-breakpoint
ALTER TABLE `__new_hr_special_workday_assignments` RENAME TO `hr_special_workday_assignments`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_employment_date` ON `hr_special_workday_assignments` (`employment_id`,`work_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_worker_date` ON `hr_special_workday_assignments` (`worker_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_assignments_date` ON `hr_special_workday_assignments` (`work_date`,`employment_id`,`worker_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_bonus_policy_members` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_version_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`weight_units` integer NOT NULL,
	`superseded_valid_to` text,
	`superseded_by_version_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_bonus_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`superseded_by_version_id`) REFERENCES `hr_bonus_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_policy_members_dates" CHECK(length("__new_hr_bonus_policy_members"."valid_from") = 10 AND ("__new_hr_bonus_policy_members"."valid_to" IS NULL OR (length("__new_hr_bonus_policy_members"."valid_to") = 10 AND "__new_hr_bonus_policy_members"."valid_to" > "__new_hr_bonus_policy_members"."valid_from"))),
	CONSTRAINT "ck_hr_bonus_policy_members_weight" CHECK("__new_hr_bonus_policy_members"."weight_units" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_bonus_policy_members`("id", "policy_version_id", "employment_id", "valid_from", "valid_to", "weight_units", "superseded_valid_to", "superseded_by_version_id", "created_by", "created_at") SELECT "id", "policy_version_id", "employment_id", "valid_from", "valid_to", "weight_units", "superseded_valid_to", "superseded_by_version_id", "created_by", "created_at" FROM `hr_bonus_policy_members`;--> statement-breakpoint
DROP TABLE `hr_bonus_policy_members`;--> statement-breakpoint
ALTER TABLE `__new_hr_bonus_policy_members` RENAME TO `hr_bonus_policy_members`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_policy_members_start` ON `hr_bonus_policy_members` (`policy_version_id`,`employment_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_policy_members_employment` ON `hr_bonus_policy_members` (`employment_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `__new_hr_payroll_adjustments` (
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
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_adjustments_source_period" CHECK("__new_hr_payroll_adjustments"."source_period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_hr_payroll_adjustments_effective_period" CHECK("__new_hr_payroll_adjustments"."effective_period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_hr_payroll_adjustments_reason" CHECK(length(trim("__new_hr_payroll_adjustments"."reason")) BETWEEN 1 AND 1000),
	CONSTRAINT "ck_hr_payroll_adjustments_revision" CHECK("__new_hr_payroll_adjustments"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_payroll_adjustments`("id", "employment_id", "source_period_key", "effective_period_key", "reason", "created_by", "created_at", "updated_by", "updated_at", "revision") SELECT "id", "employment_id", "source_period_key", "effective_period_key", "reason", "created_by", "created_at", "updated_by", "updated_at", "revision" FROM `hr_payroll_adjustments`;--> statement-breakpoint
DROP TABLE `hr_payroll_adjustments`;--> statement-breakpoint
ALTER TABLE `__new_hr_payroll_adjustments` RENAME TO `hr_payroll_adjustments`;--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustments_effective` ON `hr_payroll_adjustments` (`effective_period_key`,`employment_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_payroll_closed_employees` (
	`period_key` text NOT NULL,
	`employment_id` text NOT NULL,
	`payroll_run_id` text NOT NULL,
	`closed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`period_key`, `employment_id`),
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_closed_employees_period" CHECK("__new_hr_payroll_closed_employees"."period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
INSERT INTO `__new_hr_payroll_closed_employees`("period_key", "employment_id", "payroll_run_id", "closed_at") SELECT "period_key", "employment_id", "payroll_run_id", "closed_at" FROM `hr_payroll_closed_employees`;--> statement-breakpoint
DROP TABLE `hr_payroll_closed_employees`;--> statement-breakpoint
ALTER TABLE `__new_hr_payroll_closed_employees` RENAME TO `hr_payroll_closed_employees`;--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_closed_employees_run` ON `hr_payroll_closed_employees` (`payroll_run_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_payroll_run_employees` (
	`payroll_run_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`input_revision` integer NOT NULL,
	`status` text DEFAULT 'calculating' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`payroll_run_id`, `employment_id`),
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_run_employees_revision" CHECK("__new_hr_payroll_run_employees"."input_revision" > 0),
	CONSTRAINT "ck_hr_payroll_run_employees_status" CHECK("__new_hr_payroll_run_employees"."status" IN ('calculating', 'succeeded', 'failed')),
	CONSTRAINT "ck_hr_payroll_run_employees_error" CHECK(length("__new_hr_payroll_run_employees"."last_error") <= 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_payroll_run_employees`("payroll_run_id", "employment_id", "input_revision", "status", "last_error") SELECT "payroll_run_id", "employment_id", "input_revision", "status", "last_error" FROM `__hr_payroll_run_employees_backup`;--> statement-breakpoint
ALTER TABLE `__new_hr_payroll_run_employees` RENAME TO `hr_payroll_run_employees`;--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_run_employees_employment` ON `hr_payroll_run_employees` (`employment_id`,`payroll_run_id`);--> statement-breakpoint
CREATE TABLE `__new_hr_payslips` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`employee_number` text NOT NULL,
	`employee_name` text NOT NULL,
	`earning_minor` integer NOT NULL,
	`deduction_minor` integer NOT NULL,
	`net_minor` integer NOT NULL,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payslips_amounts" CHECK("__new_hr_payslips"."earning_minor" >= 0 AND "__new_hr_payslips"."deduction_minor" >= 0 AND "__new_hr_payslips"."net_minor" = "__new_hr_payslips"."earning_minor" - "__new_hr_payslips"."deduction_minor"),
	CONSTRAINT "ck_hr_payslips_employee_number" CHECK(length(trim("__new_hr_payslips"."employee_number")) BETWEEN 1 AND 40)
);
--> statement-breakpoint
INSERT INTO `__new_hr_payslips`("id", "payroll_run_id", "employment_id", "employee_number", "employee_name", "earning_minor", "deduction_minor", "net_minor", "published_at", "created_at") SELECT "id", "payroll_run_id", "employment_id", "employee_number", "employee_name", "earning_minor", "deduction_minor", "net_minor", "published_at", "created_at" FROM `hr_payslips`;--> statement-breakpoint
DROP TABLE `hr_payslips`;--> statement-breakpoint
ALTER TABLE `__new_hr_payslips` RENAME TO `hr_payslips`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslips_run_employment` ON `hr_payslips` (`payroll_run_id`,`employment_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payslips_employment` ON `hr_payslips` (`employment_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hr_compensation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`compensation_version_id` text NOT NULL,
	`item_name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`item_kind` text NOT NULL,
	`amount_basis` text DEFAULT 'monthly' NOT NULL,
	`include_overtime` integer DEFAULT 0 NOT NULL,
	`include_insurance` integer DEFAULT 0 NOT NULL,
	`include_tax` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `ck_hr_compensation_items_name` CHECK(length(trim(`item_name`)) BETWEEN 1 AND 100),
	CONSTRAINT `ck_hr_compensation_items_amount` CHECK(`amount_minor` >= 0),
	CONSTRAINT `ck_hr_compensation_items_kind` CHECK(`item_kind` IN ('fixed', 'variable')),
	CONSTRAINT `ck_hr_compensation_items_flags` CHECK(`include_overtime` IN (0, 1) AND `include_insurance` IN (0, 1) AND `include_tax` IN (0, 1))
);--> statement-breakpoint
INSERT INTO `hr_compensation_items`(`id`, `compensation_version_id`, `item_name`, `amount_minor`, `item_kind`, `amount_basis`, `include_overtime`, `include_insurance`, `include_tax`, `created_at`, `created_by`)
SELECT `id`, `compensation_version_id`, `item_name`, `amount_minor`, `item_kind`, `amount_basis`, `include_overtime`, `include_insurance`, `include_tax`, `created_at`, `created_by`
FROM `__hr_compensation_items_backup`;--> statement-breakpoint
CREATE INDEX `idx_hr_compensation_items_version` ON `hr_compensation_items` (`compensation_version_id`);--> statement-breakpoint
CREATE TABLE `hr_payslip_compensation_links` (
	`payslip_id` text NOT NULL,
	`compensation_version_id` text NOT NULL,
	PRIMARY KEY(`payslip_id`, `compensation_version_id`),
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `hr_payslip_compensation_links` SELECT * FROM `__hr_payslip_compensation_links_backup`;--> statement-breakpoint
CREATE TABLE `hr_payslip_insurance_links` (
	`payslip_id` text NOT NULL,
	`insurance_version_id` text NOT NULL,
	PRIMARY KEY(`payslip_id`, `insurance_version_id`),
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`insurance_version_id`) REFERENCES `hr_insurance_versions`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `hr_payslip_insurance_links` SELECT * FROM `__hr_payslip_insurance_links_backup`;--> statement-breakpoint
CREATE TABLE `hr_payslip_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`payslip_id` text NOT NULL,
	`line_key` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`quantity_seconds` integer,
	`explanation_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payslip_lines_key" CHECK(length(trim(`line_key`)) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_payslip_lines_direction" CHECK(`direction` IN ('earning', 'deduction')),
	CONSTRAINT "ck_hr_payslip_lines_amount" CHECK(`amount_minor` >= 0),
	CONSTRAINT "ck_hr_payslip_lines_quantity" CHECK(`quantity_seconds` IS NULL OR `quantity_seconds` >= 0),
	CONSTRAINT "ck_hr_payslip_lines_explanation" CHECK(length(`explanation_json`) <= 10000)
);--> statement-breakpoint
INSERT INTO `hr_payslip_lines` SELECT * FROM `__hr_payslip_lines_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslip_lines_key` ON `hr_payslip_lines` (`payslip_id`,`line_key`);--> statement-breakpoint
DROP TABLE `__hr_compensation_items_backup`;--> statement-breakpoint
DROP TABLE `__hr_payroll_run_employees_backup`;--> statement-breakpoint
DROP TABLE `__hr_payslip_compensation_links_backup`;--> statement-breakpoint
DROP TABLE `__hr_payslip_insurance_links_backup`;--> statement-breakpoint
DROP TABLE `__hr_payslip_lines_backup`;