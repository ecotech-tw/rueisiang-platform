-- 0220：把正式員工與排班支援人員合併到同一個 canonical employment parent。
-- 先把所有受影響資料表完整 staging；不使用 PRAGMA foreign_keys=OFF，避免 D1 transaction 連坐刪除。
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_employments" AS SELECT * FROM "hr_employments";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_schedule_workers" AS SELECT * FROM "hr_schedule_workers";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_employment_service_periods" AS SELECT * FROM "hr_employment_service_periods";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_employee_scopes" AS SELECT * FROM "hr_employee_scopes";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_clock_events" AS SELECT * FROM "hr_clock_events";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_employee_attendance_locations" AS SELECT * FROM "hr_employee_attendance_locations";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_employment_attendance_settings" AS SELECT * FROM "hr_employment_attendance_settings";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_compensation_versions" AS SELECT * FROM "hr_compensation_versions";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_insurance_versions" AS SELECT * FROM "hr_insurance_versions";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_monthly_hourly_entries" AS SELECT * FROM "hr_monthly_hourly_entries";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_monthly_leave_entries" AS SELECT * FROM "hr_monthly_leave_entries";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_overtime_requests" AS SELECT * FROM "hr_overtime_requests";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_schedule_entries" AS SELECT * FROM "hr_schedule_entries";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_bonus_policy_members" AS SELECT * FROM "hr_bonus_policy_members";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_closed_employees" AS SELECT * FROM "hr_payroll_closed_employees";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_run_employees" AS SELECT * FROM "hr_payroll_run_employees";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payslips" AS SELECT * FROM "hr_payslips";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_annual_leave_entitlements" AS SELECT * FROM "hr_annual_leave_entitlements";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_leave_requests" AS SELECT * FROM "hr_leave_requests";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_special_workday_assignments" AS SELECT * FROM "hr_special_workday_assignments";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_adjustments" AS SELECT * FROM "hr_payroll_adjustments";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_record_items" AS SELECT * FROM "hr_payroll_record_items";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_form_requests" AS SELECT * FROM "hr_form_requests";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_worker_compensation_versions" AS SELECT * FROM "hr_worker_compensation_versions";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_schedule_worker_entries" AS SELECT * FROM "hr_schedule_worker_entries";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_worker_results" AS SELECT * FROM "hr_payroll_worker_results";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_closed_workers" AS SELECT * FROM "hr_payroll_closed_workers";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_worker_overtime_requests" AS SELECT * FROM "hr_worker_overtime_requests";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_compensation_items" AS SELECT * FROM "hr_compensation_items";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payslip_compensation_links" AS SELECT * FROM "hr_payslip_compensation_links";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payslip_insurance_links" AS SELECT * FROM "hr_payslip_insurance_links";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payslip_lines" AS SELECT * FROM "hr_payslip_lines";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_annual_leave_ledger" AS SELECT * FROM "hr_annual_leave_ledger";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_hr_payroll_adjustment_items" AS SELECT * FROM "hr_payroll_adjustment_items";
--> statement-breakpoint
-- 先檢查人員 ID 與所有活動人員的編號，碰撞時在任何舊表 DROP 前中止，避免把問題留到重建途中才發現。
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_employment_ids" (`id` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TRIGGER "__hr_unify_0220_employment_id_collision"
BEFORE INSERT ON "__hr_unify_0220_employment_ids"
WHEN EXISTS (SELECT 1 FROM "__hr_unify_0220_employment_ids" WHERE "id" = NEW."id")
BEGIN
  SELECT RAISE(ABORT, 'hr_unify_0220_employment_id_collision');
END;
--> statement-breakpoint
INSERT INTO "__hr_unify_0220_employment_ids" (`id`)
SELECT `id` FROM "__hr_unify_0220_hr_employments";
--> statement-breakpoint
INSERT INTO "__hr_unify_0220_employment_ids" (`id`)
SELECT `id` FROM "__hr_unify_0220_hr_schedule_workers";
--> statement-breakpoint
CREATE TABLE "__hr_unify_0220_employee_numbers" (`employee_number` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TRIGGER "__hr_unify_0220_employee_number_collision"
BEFORE INSERT ON "__hr_unify_0220_employee_numbers"
WHEN EXISTS (SELECT 1 FROM "__hr_unify_0220_employee_numbers" WHERE "employee_number" = NEW."employee_number")
BEGIN
  SELECT RAISE(ABORT, 'hr_unify_0220_employee_number_collision');
END;
--> statement-breakpoint
INSERT INTO "__hr_unify_0220_employee_numbers" (`employee_number`)
SELECT `employee_number` FROM "__hr_unify_0220_hr_employments" WHERE `archived_at` IS NULL;
--> statement-breakpoint
INSERT INTO "__hr_unify_0220_employee_numbers" (`employee_number`)
SELECT 'W-' || replace(`id`, '-', '') FROM "__hr_unify_0220_hr_schedule_workers" WHERE `active` = 1;
--> statement-breakpoint
-- 先拆最深的子表，再拆直接指向舊 employment／worker parent 的表。
--> statement-breakpoint
DROP TABLE "hr_employment_service_periods";
--> statement-breakpoint
DROP TABLE "hr_employee_scopes";
--> statement-breakpoint
DROP TABLE "hr_clock_events";
--> statement-breakpoint
DROP TABLE "hr_employment_attendance_settings";
--> statement-breakpoint
DROP TABLE "hr_employee_attendance_locations";
--> statement-breakpoint
DROP TABLE "hr_compensation_items";
--> statement-breakpoint
DROP TABLE "hr_payslip_compensation_links";
--> statement-breakpoint
DROP TABLE "hr_compensation_versions";
--> statement-breakpoint
DROP TABLE "hr_payslip_insurance_links";
--> statement-breakpoint
DROP TABLE "hr_insurance_versions";
--> statement-breakpoint
DROP TABLE "hr_monthly_hourly_entries";
--> statement-breakpoint
DROP TABLE "hr_monthly_leave_entries";
--> statement-breakpoint
DROP TABLE "hr_overtime_requests";
--> statement-breakpoint
DROP TABLE "hr_schedule_entries";
--> statement-breakpoint
DROP TABLE "hr_bonus_policy_members";
--> statement-breakpoint
DROP TABLE "hr_payroll_closed_employees";
--> statement-breakpoint
DROP TABLE "hr_payroll_run_employees";
--> statement-breakpoint
DROP TABLE "hr_payslip_lines";
--> statement-breakpoint
DROP TABLE "hr_payslips";
--> statement-breakpoint
DROP TABLE "hr_annual_leave_ledger";
--> statement-breakpoint
DROP TABLE "hr_annual_leave_entitlements";
--> statement-breakpoint
DROP TABLE "hr_leave_requests";
--> statement-breakpoint
DROP TABLE "hr_special_workday_assignments";
--> statement-breakpoint
DROP TABLE "hr_payroll_adjustment_items";
--> statement-breakpoint
DROP TABLE "hr_payroll_adjustments";
--> statement-breakpoint
DROP TABLE "hr_payroll_record_items";
--> statement-breakpoint
DROP TABLE "hr_form_requests";
--> statement-breakpoint
DROP TABLE "hr_payroll_worker_results";
--> statement-breakpoint
DROP TABLE "hr_worker_compensation_versions";
--> statement-breakpoint
DROP TABLE "hr_schedule_worker_entries";
--> statement-breakpoint
DROP TABLE "hr_payroll_closed_workers";
--> statement-breakpoint
DROP TABLE "hr_worker_overtime_requests";
--> statement-breakpoint
DROP TABLE `hr_schedule_workers`;
--> statement-breakpoint
DROP TABLE `hr_employments`;
--> statement-breakpoint
CREATE TABLE `hr_employments` (
  `id` text PRIMARY KEY NOT NULL,
  `person_kind` text DEFAULT 'employee' NOT NULL,
  `employee_user_id` text,
  `employee_number` text NOT NULL,
  `legal_name` text DEFAULT '' NOT NULL,
  `position` text DEFAULT '一般職員' NOT NULL,
  `supervisor_user_id` text,
  `archived_at` text,
  `revision` integer DEFAULT 1 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`employee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`supervisor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_employments_person_kind` CHECK (`person_kind` IN ('employee', 'worker')),
  CONSTRAINT `ck_hr_employments_employee_user` CHECK ((`person_kind` = 'employee' AND `employee_user_id` IS NOT NULL) OR (`person_kind` = 'worker' AND `employee_user_id` IS NULL)),
  CONSTRAINT `ck_hr_employments_number` CHECK (length(trim(`employee_number`)) BETWEEN 1 AND 40),
  CONSTRAINT `ck_hr_employments_position` CHECK (length(trim(`position`)) BETWEEN 1 AND 100),
  CONSTRAINT `ck_hr_employments_revision` CHECK (`revision` > 0)
);
--> statement-breakpoint
INSERT INTO `hr_employments` (`id`, `person_kind`, `employee_user_id`, `employee_number`, `legal_name`, `position`, `supervisor_user_id`, `archived_at`, `revision`, `created_at`, `updated_at`)
SELECT `id`, 'employee', `employee_user_id`, `employee_number`, `legal_name`, `position`, `supervisor_user_id`, `archived_at`, `revision`, `created_at`, `updated_at`
FROM `__hr_unify_0220_hr_employments`;
--> statement-breakpoint
INSERT INTO `hr_employments` (`id`, `person_kind`, `employee_user_id`, `employee_number`, `legal_name`, `position`, `supervisor_user_id`, `archived_at`, `revision`, `created_at`, `updated_at`)
SELECT `id`, 'worker', NULL, 'W-' || replace(`id`, '-', ''), `display_name`, '支援人員', NULL,
  CASE WHEN `active` = 1 THEN NULL ELSE `updated_at` END, `revision`, `created_at`, `updated_at`
FROM `__hr_unify_0220_hr_schedule_workers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employments_active_user` ON `hr_employments` (`employee_user_id`) WHERE `archived_at` IS NULL AND `employee_user_id` IS NOT NULL AND `person_kind` = 'employee';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employments_active_number` ON `hr_employments` (`employee_number`) WHERE `archived_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_hr_employments_archived` ON `hr_employments` (`archived_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_employments_person_kind_status` ON `hr_employments` (`person_kind`, `archived_at`);
--> statement-breakpoint
CREATE TABLE `hr_schedule_workers` (
  `id` text PRIMARY KEY NOT NULL,
  `employment_id` text NOT NULL REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  `display_name` text NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  CONSTRAINT `ck_hr_schedule_workers_name` CHECK(length(trim(`display_name`)) BETWEEN 1 AND 100),
  CONSTRAINT `ck_hr_schedule_workers_active` CHECK(`active` IN (0, 1)),
  CONSTRAINT `ck_hr_schedule_workers_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
INSERT INTO `hr_schedule_workers` (`id`, `employment_id`, `display_name`, `active`, `created_by`, `created_at`, `updated_at`, `revision`)
SELECT `id`, `id`, `display_name`, `active`, `created_by`, `created_at`, `updated_at`, `revision`
FROM `__hr_unify_0220_hr_schedule_workers`;
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_workers_active_name` ON `hr_schedule_workers` (`active`, `display_name`);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_workers_employment` ON `hr_schedule_workers` (`employment_id`);
--> statement-breakpoint
-- 先建表，再回填原資料；workerId 欄位的值不變，只把外鍵 parent 改成 canonical hr_employments。
--> statement-breakpoint
CREATE TABLE "hr_annual_leave_entitlements" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_annual_leave_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bracket_id`) REFERENCES `hr_annual_leave_brackets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_entitlement_dates" CHECK(length("hr_annual_leave_entitlements"."period_start") = 10 AND length("hr_annual_leave_entitlements"."period_end") = 10 AND "hr_annual_leave_entitlements"."period_end" > "hr_annual_leave_entitlements"."period_start"),
	CONSTRAINT "ck_hr_annual_leave_entitlement_service" CHECK("hr_annual_leave_entitlements"."service_months" >= 6),
	CONSTRAINT "ck_hr_annual_leave_entitlement_amount" CHECK("hr_annual_leave_entitlements"."entitled_half_hours" > 0),
	CONSTRAINT "ck_hr_annual_leave_entitlement_status" CHECK("hr_annual_leave_entitlements"."status" IN ('open', 'settled'))
);
--> statement-breakpoint
CREATE TABLE "hr_bonus_policy_members" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`superseded_by_version_id`) REFERENCES `hr_bonus_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_bonus_policy_members_dates" CHECK(length("hr_bonus_policy_members"."valid_from") = 10 AND ("hr_bonus_policy_members"."valid_to" IS NULL OR (length("hr_bonus_policy_members"."valid_to") = 10 AND "hr_bonus_policy_members"."valid_to" > "hr_bonus_policy_members"."valid_from"))),
	CONSTRAINT "ck_hr_bonus_policy_members_weight" CHECK("hr_bonus_policy_members"."weight_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr_clock_events" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attendance_location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_clock_events_source" CHECK("hr_clock_events"."source_kind" IN ('portal', 'rfid', 'line', 'manual')),
	CONSTRAINT "ck_hr_clock_events_kind" CHECK("hr_clock_events"."event_kind" IN ('clock_in', 'clock_out')),
	CONSTRAINT "ck_hr_clock_events_coordinate_pair" CHECK(("hr_clock_events"."latitude_e7" IS NULL AND "hr_clock_events"."longitude_e7" IS NULL) OR ("hr_clock_events"."latitude_e7" IS NOT NULL AND "hr_clock_events"."longitude_e7" IS NOT NULL)),
	CONSTRAINT "ck_hr_clock_events_latitude" CHECK("hr_clock_events"."latitude_e7" IS NULL OR "hr_clock_events"."latitude_e7" BETWEEN -900000000 AND 900000000),
	CONSTRAINT "ck_hr_clock_events_longitude" CHECK("hr_clock_events"."longitude_e7" IS NULL OR "hr_clock_events"."longitude_e7" BETWEEN -1800000000 AND 1800000000),
	CONSTRAINT "ck_hr_clock_events_distance" CHECK("hr_clock_events"."distance_meters" IS NULL OR "hr_clock_events"."distance_meters" >= 0),
	CONSTRAINT "ck_hr_clock_events_anomaly" CHECK("hr_clock_events"."time_anomaly_kind" IS NULL OR "hr_clock_events"."time_anomaly_kind" IN ('early', 'late', 'early_leave', 'overtime', 'rest_day')),
	CONSTRAINT "ck_hr_clock_events_expected_start" CHECK("hr_clock_events"."expected_start_minute" IS NULL OR "hr_clock_events"."expected_start_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "ck_hr_clock_events_expected_end" CHECK("hr_clock_events"."expected_end_minute" IS NULL OR "hr_clock_events"."expected_end_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "ck_hr_clock_events_tolerance" CHECK("hr_clock_events"."tolerance_minutes" IS NULL OR "hr_clock_events"."tolerance_minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "hr_compensation_versions" (
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
	`created_by` text NOT NULL, `overtime_hourly_minor` integer,
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_compensation_versions_number" CHECK("hr_compensation_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_compensation_versions_dates" CHECK(length("hr_compensation_versions"."valid_from") = 10 AND ("hr_compensation_versions"."valid_to" IS NULL OR (length("hr_compensation_versions"."valid_to") = 10 AND "hr_compensation_versions"."valid_to" > "hr_compensation_versions"."valid_from"))),
	CONSTRAINT "ck_hr_compensation_versions_basis" CHECK("hr_compensation_versions"."pay_basis" IN ('monthly', 'daily', 'hourly')),
	CONSTRAINT "ck_hr_compensation_versions_amount" CHECK("hr_compensation_versions"."base_amount_minor" >= 0),
	CONSTRAINT "ck_hr_compensation_versions_note" CHECK(length("hr_compensation_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "hr_employee_attendance_locations" (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`location_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_attendance_locations_dates" CHECK(length("hr_employee_attendance_locations"."valid_from") = 10 AND ("hr_employee_attendance_locations"."valid_to" IS NULL OR (length("hr_employee_attendance_locations"."valid_to") = 10 AND "hr_employee_attendance_locations"."valid_to" > "hr_employee_attendance_locations"."valid_from"))),
	CONSTRAINT "ck_hr_employee_attendance_locations_revision" CHECK("hr_employee_attendance_locations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr_employee_scopes" (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_scopes_dates" CHECK(length("hr_employee_scopes"."valid_from") = 10 AND ("hr_employee_scopes"."valid_to" IS NULL OR (length("hr_employee_scopes"."valid_to") = 10 AND "hr_employee_scopes"."valid_to" > "hr_employee_scopes"."valid_from"))),
	CONSTRAINT "ck_hr_employee_scopes_revision" CHECK("hr_employee_scopes"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `hr_employment_service_periods` (
  `employment_id` text PRIMARY KEY NOT NULL,
  `service_start_on` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT "ck_hr_employment_service_periods_date" CHECK(length(`service_start_on`) = 10)
);
--> statement-breakpoint
CREATE TABLE "hr_form_requests" (
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
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approver_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_form_requests_kind" CHECK("hr_form_requests"."form_kind" = 'clock_correction'),
	CONSTRAINT "ck_hr_form_requests_status" CHECK("hr_form_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_form_requests_event_kind" CHECK("hr_form_requests"."requested_event_kind" IN ('clock_in', 'clock_out')),
	CONSTRAINT "ck_hr_form_requests_date" CHECK(length("hr_form_requests"."correction_date") = 10),
	CONSTRAINT "ck_hr_form_requests_reason" CHECK(length(trim("hr_form_requests"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "hr_insurance_versions" (
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
	`created_by` text NOT NULL, `voided_at` text, `voided_by` text REFERENCES users(id), `superseded_valid_to` text, `superseded_by_version_id` text REFERENCES hr_insurance_versions(id),
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
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
CREATE TABLE `hr_leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`leave_type_id` text,
	`leave_type` text NOT NULL,
	`status` text NOT NULL,
	`starts_at` text DEFAULT '' NOT NULL,
	`ends_at` text DEFAULT '' NOT NULL,
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
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_requests_type" CHECK(length(trim("hr_leave_requests"."leave_type")) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_leave_requests_status" CHECK("hr_leave_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_leave_requests_dates" CHECK(length("hr_leave_requests"."starts_on") = 10 AND length("hr_leave_requests"."ends_on") = 10 AND "hr_leave_requests"."ends_on" > "hr_leave_requests"."starts_on"),
	CONSTRAINT "ck_hr_leave_requests_duration" CHECK("hr_leave_requests"."duration_minutes" > 0),
	CONSTRAINT "ck_hr_leave_requests_pay_rate" CHECK("hr_leave_requests"."pay_rate_ppm" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_hr_leave_requests_reason" CHECK(length("hr_leave_requests"."reason") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "hr_monthly_hourly_entries" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_monthly_hourly_entries_date" CHECK(length("hr_monthly_hourly_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_monthly_hourly_entries_hours" CHECK("hr_monthly_hourly_entries"."hours_half_units" >= 0),
	CONSTRAINT "ck_hr_monthly_hourly_entries_no_work" CHECK("hr_monthly_hourly_entries"."no_work" IN (0, 1)),
	CONSTRAINT "ck_hr_monthly_hourly_entries_state" CHECK("hr_monthly_hourly_entries"."no_work" = 1 OR "hr_monthly_hourly_entries"."hours_half_units" > 0),
	CONSTRAINT "ck_hr_monthly_hourly_entries_note" CHECK(length("hr_monthly_hourly_entries"."note") <= 1000),
	CONSTRAINT "ck_hr_monthly_hourly_entries_revision" CHECK("hr_monthly_hourly_entries"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr_monthly_leave_entries" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_monthly_leave_entries_date" CHECK(length("hr_monthly_leave_entries"."leave_date") = 10),
	CONSTRAINT "ck_hr_monthly_leave_entries_hours" CHECK("hr_monthly_leave_entries"."hours_half_units" > 0),
	CONSTRAINT "ck_hr_monthly_leave_entries_rate" CHECK("hr_monthly_leave_entries"."pay_rate_ppm" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_hr_monthly_leave_entries_deduction" CHECK("hr_monthly_leave_entries"."deduction_amount" >= 0),
	CONSTRAINT "ck_hr_monthly_leave_entries_note" CHECK(length("hr_monthly_leave_entries"."note") <= 1000),
	CONSTRAINT "ck_hr_monthly_leave_entries_revision" CHECK("hr_monthly_leave_entries"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr_overtime_requests" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_overtime_requested_period" CHECK("hr_overtime_requests"."requested_end" > "hr_overtime_requests"."requested_start"),
	CONSTRAINT "ck_hr_overtime_actual_pair" CHECK(("hr_overtime_requests"."actual_start" IS NULL AND "hr_overtime_requests"."actual_end" IS NULL) OR ("hr_overtime_requests"."actual_start" IS NOT NULL AND "hr_overtime_requests"."actual_end" IS NOT NULL AND "hr_overtime_requests"."actual_end" > "hr_overtime_requests"."actual_start")),
	CONSTRAINT "ck_hr_overtime_settlement" CHECK("hr_overtime_requests"."settlement_kind" IN ('pay', 'compensatory')),
	CONSTRAINT "ck_hr_overtime_status" CHECK("hr_overtime_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_overtime_rate" CHECK("hr_overtime_requests"."rate_ppm" BETWEEN 0 AND 10000000),
	CONSTRAINT "ck_hr_overtime_reason" CHECK(length("hr_overtime_requests"."reason") <= 1000),
	CONSTRAINT "ck_hr_overtime_decision_reason" CHECK(length("hr_overtime_requests"."decision_reason") <= 1000),
	CONSTRAINT "ck_hr_overtime_revision" CHECK("hr_overtime_requests"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `hr_payroll_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`effective_period_key` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_adjustments_effective_period" CHECK("hr_payroll_adjustments"."effective_period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_hr_payroll_adjustments_reason" CHECK(length(trim("hr_payroll_adjustments"."reason")) BETWEEN 1 AND 1000),
	CONSTRAINT "ck_hr_payroll_adjustments_revision" CHECK("hr_payroll_adjustments"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_closed_employees" (
	`period_key` text NOT NULL,
	`employment_id` text NOT NULL,
	`payroll_run_id` text NOT NULL,
	`closed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`period_key`, `employment_id`),
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_closed_employees_period" CHECK("hr_payroll_closed_employees"."period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE TABLE `hr_payroll_closed_workers` (
	`period_key` text NOT NULL,
	`worker_id` text NOT NULL,
	`payroll_run_id` text NOT NULL,
	`closed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`period_key`, `worker_id`),
	FOREIGN KEY (`worker_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_closed_workers_period" CHECK("hr_payroll_closed_workers"."period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_record_items" (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`person_kind` text NOT NULL,
	`employment_id` text,
	`worker_id` text,
	`item_name` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_record_items_person" CHECK(("hr_payroll_record_items"."person_kind" = 'employee' AND "hr_payroll_record_items"."employment_id" IS NOT NULL AND "hr_payroll_record_items"."worker_id" IS NULL) OR ("hr_payroll_record_items"."person_kind" = 'worker' AND "hr_payroll_record_items"."employment_id" IS NULL AND "hr_payroll_record_items"."worker_id" IS NOT NULL)),
	CONSTRAINT "ck_hr_payroll_record_items_name" CHECK(length(trim("hr_payroll_record_items"."item_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_payroll_record_items_direction" CHECK("hr_payroll_record_items"."direction" IN ('earning', 'deduction')),
	CONSTRAINT "ck_hr_payroll_record_items_amount" CHECK("hr_payroll_record_items"."amount_minor" > 0),
	CONSTRAINT "ck_hr_payroll_record_items_reason" CHECK(length(trim("hr_payroll_record_items"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_run_employees" (
	`payroll_run_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`input_revision` integer NOT NULL,
	`status` text DEFAULT 'calculating' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`payroll_run_id`, `employment_id`),
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_run_employees_revision" CHECK("hr_payroll_run_employees"."input_revision" > 0),
	CONSTRAINT "ck_hr_payroll_run_employees_status" CHECK("hr_payroll_run_employees"."status" IN ('calculating', 'succeeded', 'failed')),
	CONSTRAINT "ck_hr_payroll_run_employees_error" CHECK(length("hr_payroll_run_employees"."last_error") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "hr_payslips" (
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
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payslips_amounts" CHECK("hr_payslips"."earning_minor" >= 0 AND "hr_payslips"."deduction_minor" >= 0 AND "hr_payslips"."net_minor" = "hr_payslips"."earning_minor" - "hr_payslips"."deduction_minor"),
	CONSTRAINT "ck_hr_payslips_employee_number" CHECK(length(trim("hr_payslips"."employee_number")) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE "hr_schedule_entries" (
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
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `shift_group_id` text, `required_headcount` integer DEFAULT 1 NOT NULL, `attendance_status` text DEFAULT 'scheduled' NOT NULL,
	FOREIGN KEY (`schedule_version_id`) REFERENCES `hr_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_version_id`) REFERENCES `hr_shift_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_entries_date" CHECK(length("hr_schedule_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_schedule_entries_period" CHECK("hr_schedule_entries"."ends_at" > "hr_schedule_entries"."starts_at"),
	CONSTRAINT "ck_hr_schedule_entries_standard" CHECK("hr_schedule_entries"."standard_minutes" BETWEEN 0 AND 1440),
	CONSTRAINT "ck_hr_schedule_entries_break" CHECK("hr_schedule_entries"."break_minutes" BETWEEN 0 AND 1440)
);
--> statement-breakpoint
CREATE TABLE `hr_schedule_worker_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_version_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`shift_version_id` text NOT NULL,
	`work_date` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `standard_minutes` integer NOT NULL DEFAULT 480, `break_minutes` integer NOT NULL DEFAULT 60, `shift_group_id` text, `required_headcount` integer DEFAULT 1 NOT NULL, `attendance_status` text DEFAULT 'scheduled' NOT NULL,
	FOREIGN KEY (`schedule_version_id`) REFERENCES `hr_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_version_id`) REFERENCES `hr_shift_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_worker_entries_date" CHECK(length("hr_schedule_worker_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_schedule_worker_entries_period" CHECK("hr_schedule_worker_entries"."ends_at" > "hr_schedule_worker_entries"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "hr_special_workday_assignments" (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`employment_id` text,
	`worker_id` text,
	`work_date` text NOT NULL,
	`allowance_snapshot_json` text DEFAULT '[]' NOT NULL,
	`allowance_quantity` integer DEFAULT 0 NOT NULL,
	`applied_by` text NOT NULL,
	`applied_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `hr_special_workday_rules`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_special_workday_assignments_target" CHECK(("hr_special_workday_assignments"."employment_id" IS NOT NULL AND "hr_special_workday_assignments"."worker_id" IS NULL) OR ("hr_special_workday_assignments"."employment_id" IS NULL AND "hr_special_workday_assignments"."worker_id" IS NOT NULL)),
	CONSTRAINT "ck_hr_special_workday_assignments_date" CHECK(length("hr_special_workday_assignments"."work_date") = 10),
	CONSTRAINT "ck_hr_special_workday_assignments_quantity" CHECK("hr_special_workday_assignments"."allowance_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE `hr_worker_compensation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`pay_basis` text NOT NULL,
	`base_amount_minor` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL, `overtime_rate_ppm` integer, `overtime_hourly_minor` integer,
	FOREIGN KEY (`worker_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_worker_compensation_versions_number" CHECK("hr_worker_compensation_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_worker_compensation_versions_dates" CHECK(length("hr_worker_compensation_versions"."valid_from") = 10 AND ("hr_worker_compensation_versions"."valid_to" IS NULL OR (length("hr_worker_compensation_versions"."valid_to") = 10 AND "hr_worker_compensation_versions"."valid_to" > "hr_worker_compensation_versions"."valid_from"))),
	CONSTRAINT "ck_hr_worker_compensation_versions_basis" CHECK("hr_worker_compensation_versions"."pay_basis" IN ('monthly', 'daily', 'hourly')),
	CONSTRAINT "ck_hr_worker_compensation_versions_amount" CHECK("hr_worker_compensation_versions"."base_amount_minor" >= 0),
	CONSTRAINT "ck_hr_worker_compensation_versions_note" CHECK(length("hr_worker_compensation_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE `hr_worker_overtime_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `worker_id` text NOT NULL REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
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
);
--> statement-breakpoint
CREATE TABLE `hr_annual_leave_ledger` (
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
);
--> statement-breakpoint
CREATE TABLE "hr_employment_attendance_settings" (
	`employment_id` text PRIMARY KEY NOT NULL,
	`attendance_mode` text DEFAULT 'general' NOT NULL,
	`monthly_rest_days` integer,
	`primary_assignment_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_assignment_id`) REFERENCES `hr_employee_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employment_attendance_settings_mode" CHECK("hr_employment_attendance_settings"."attendance_mode" IN ('general', 'scheduled')),
	CONSTRAINT "ck_hr_employment_attendance_settings_rest_days" CHECK("hr_employment_attendance_settings"."monthly_rest_days" IS NULL OR "hr_employment_attendance_settings"."monthly_rest_days" BETWEEN 0 AND 31)
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_adjustment_items" (
	`id` text PRIMARY KEY NOT NULL,
	`adjustment_id` text NOT NULL,
	`item_name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`adjustment_id`) REFERENCES `hr_payroll_adjustments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_adjustment_items_name" CHECK(length(trim("hr_payroll_adjustment_items"."item_name")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_worker_results" (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`compensation_version_id` text,
	`pay_basis` text NOT NULL,
	`scheduled_days` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`typhoon_stop_days` integer DEFAULT 0 NOT NULL,
	`typhoon_stop_pay_minor` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `schedule_allocation_json` text DEFAULT '[]' NOT NULL, `overtime_minor` integer DEFAULT 0 NOT NULL, `overtime_seconds` integer DEFAULT 0 NOT NULL, `overtime_explanation_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES "hr_employments"(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_worker_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_worker_results_name" CHECK(length(trim("hr_payroll_worker_results"."worker_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_payroll_worker_results_days" CHECK("hr_payroll_worker_results"."scheduled_days" >= 0),
	CONSTRAINT "ck_hr_payroll_worker_results_amount" CHECK("hr_payroll_worker_results"."amount_minor" >= 0),
	CONSTRAINT "ck_hr_payroll_worker_results_typhoon_days" CHECK("hr_payroll_worker_results"."typhoon_stop_days" >= 0 AND "hr_payroll_worker_results"."typhoon_stop_days" <= "hr_payroll_worker_results"."scheduled_days"),
	CONSTRAINT "ck_hr_payroll_worker_results_typhoon_amount" CHECK("hr_payroll_worker_results"."typhoon_stop_pay_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE `hr_payslip_compensation_links` (
	`payslip_id` text NOT NULL,
	`compensation_version_id` text NOT NULL,
	PRIMARY KEY(`payslip_id`, `compensation_version_id`),
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `hr_payslip_insurance_links` (
	`payslip_id` text NOT NULL,
	`insurance_version_id` text NOT NULL,
	PRIMARY KEY(`payslip_id`, `insurance_version_id`),
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`insurance_version_id`) REFERENCES `hr_insurance_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
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
);
--> statement-breakpoint
INSERT INTO "hr_annual_leave_entitlements" SELECT * FROM "__hr_unify_0220_hr_annual_leave_entitlements";
--> statement-breakpoint
INSERT INTO "hr_bonus_policy_members" SELECT * FROM "__hr_unify_0220_hr_bonus_policy_members";
--> statement-breakpoint
INSERT INTO "hr_clock_events" SELECT * FROM "__hr_unify_0220_hr_clock_events";
--> statement-breakpoint
INSERT INTO "hr_compensation_versions" SELECT * FROM "__hr_unify_0220_hr_compensation_versions";
--> statement-breakpoint
INSERT INTO "hr_employee_attendance_locations" SELECT * FROM "__hr_unify_0220_hr_employee_attendance_locations";
--> statement-breakpoint
INSERT INTO "hr_employee_scopes" SELECT * FROM "__hr_unify_0220_hr_employee_scopes";
--> statement-breakpoint
INSERT INTO "hr_employment_service_periods" SELECT * FROM "__hr_unify_0220_hr_employment_service_periods";
--> statement-breakpoint
INSERT INTO "hr_form_requests" SELECT * FROM "__hr_unify_0220_hr_form_requests";
--> statement-breakpoint
INSERT INTO "hr_insurance_versions" SELECT * FROM "__hr_unify_0220_hr_insurance_versions";
--> statement-breakpoint
INSERT INTO "hr_leave_requests" SELECT * FROM "__hr_unify_0220_hr_leave_requests";
--> statement-breakpoint
INSERT INTO "hr_monthly_hourly_entries" SELECT * FROM "__hr_unify_0220_hr_monthly_hourly_entries";
--> statement-breakpoint
INSERT INTO "hr_monthly_leave_entries" SELECT * FROM "__hr_unify_0220_hr_monthly_leave_entries";
--> statement-breakpoint
INSERT INTO "hr_overtime_requests" SELECT * FROM "__hr_unify_0220_hr_overtime_requests";
--> statement-breakpoint
INSERT INTO "hr_payroll_adjustments" SELECT * FROM "__hr_unify_0220_hr_payroll_adjustments";
--> statement-breakpoint
INSERT INTO "hr_payroll_closed_employees" SELECT * FROM "__hr_unify_0220_hr_payroll_closed_employees";
--> statement-breakpoint
INSERT INTO "hr_payroll_closed_workers" SELECT * FROM "__hr_unify_0220_hr_payroll_closed_workers";
--> statement-breakpoint
INSERT INTO "hr_payroll_record_items" SELECT * FROM "__hr_unify_0220_hr_payroll_record_items";
--> statement-breakpoint
INSERT INTO "hr_payroll_run_employees" SELECT * FROM "__hr_unify_0220_hr_payroll_run_employees";
--> statement-breakpoint
INSERT INTO "hr_payslips" SELECT * FROM "__hr_unify_0220_hr_payslips";
--> statement-breakpoint
INSERT INTO "hr_schedule_entries" SELECT * FROM "__hr_unify_0220_hr_schedule_entries";
--> statement-breakpoint
INSERT INTO "hr_schedule_worker_entries" SELECT * FROM "__hr_unify_0220_hr_schedule_worker_entries";
--> statement-breakpoint
INSERT INTO "hr_special_workday_assignments" SELECT * FROM "__hr_unify_0220_hr_special_workday_assignments";
--> statement-breakpoint
INSERT INTO "hr_worker_compensation_versions" SELECT * FROM "__hr_unify_0220_hr_worker_compensation_versions";
--> statement-breakpoint
INSERT INTO "hr_worker_overtime_requests" SELECT * FROM "__hr_unify_0220_hr_worker_overtime_requests";
--> statement-breakpoint
INSERT INTO "hr_annual_leave_ledger" SELECT * FROM "__hr_unify_0220_hr_annual_leave_ledger";
--> statement-breakpoint
INSERT INTO "hr_compensation_items" SELECT * FROM "__hr_unify_0220_hr_compensation_items";
--> statement-breakpoint
INSERT INTO "hr_employment_attendance_settings" SELECT * FROM "__hr_unify_0220_hr_employment_attendance_settings";
--> statement-breakpoint
INSERT INTO "hr_payroll_adjustment_items" SELECT * FROM "__hr_unify_0220_hr_payroll_adjustment_items";
--> statement-breakpoint
INSERT INTO "hr_payroll_worker_results" SELECT * FROM "__hr_unify_0220_hr_payroll_worker_results";
--> statement-breakpoint
INSERT INTO "hr_payslip_compensation_links" SELECT * FROM "__hr_unify_0220_hr_payslip_compensation_links";
--> statement-breakpoint
INSERT INTO "hr_payslip_insurance_links" SELECT * FROM "__hr_unify_0220_hr_payslip_insurance_links";
--> statement-breakpoint
INSERT INTO "hr_payslip_lines" SELECT * FROM "__hr_unify_0220_hr_payslip_lines";
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_worker_compensation_versions_number` ON `hr_worker_compensation_versions` (`worker_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `idx_hr_worker_compensation_versions_period` ON `hr_worker_compensation_versions` (`worker_id`,`valid_from`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_worker_entries_unique` ON `hr_schedule_worker_entries` (`schedule_version_id`,`worker_id`,`work_date`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_worker_entries_worker_date` ON `hr_schedule_worker_entries` (`worker_id`,`work_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_worker_entries_scope_date` ON `hr_schedule_worker_entries` (`scope_id`,`work_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_scopes_start` ON `hr_employee_scopes` (`employment_id`,`scope_id`,`valid_from`);
--> statement-breakpoint
CREATE INDEX `idx_hr_employee_scopes_scope` ON `hr_employee_scopes` (`scope_id`,`valid_from`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_clock_events_idempotency` ON `hr_clock_events` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_clock_events_correction_request` ON `hr_clock_events` (`correction_request_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_clock_events_employee_occurred` ON `hr_clock_events` (`employee_user_id`,`occurred_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_attendance_locations_start` ON `hr_employee_attendance_locations` (`employment_id`,`location_id`,`valid_from`);
--> statement-breakpoint
CREATE INDEX `idx_hr_employee_attendance_locations_location` ON `hr_employee_attendance_locations` (`location_id`,`valid_from`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_compensation_versions_number` ON `hr_compensation_versions` (`employment_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `idx_hr_compensation_versions_period` ON `hr_compensation_versions` (`employment_id`,`valid_from`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_insurance_versions_number` ON `hr_insurance_versions` (`employment_id`,`scheme`,`version_number`);
--> statement-breakpoint
CREATE INDEX `idx_hr_insurance_versions_period` ON `hr_insurance_versions` (`employment_id`,`scheme`,`valid_from`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_monthly_hourly_entries_unique` ON `hr_monthly_hourly_entries` (`employment_id`,`work_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_monthly_hourly_entries_date` ON `hr_monthly_hourly_entries` (`work_date`,`employment_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_monthly_leave_entries_unique` ON `hr_monthly_leave_entries` (`employment_id`,`leave_type_id`,`leave_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_monthly_leave_entries_date` ON `hr_monthly_leave_entries` (`leave_date`,`employment_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_employment_start` ON `hr_overtime_requests` (`employment_id`,`requested_start`);
--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_status` ON `hr_overtime_requests` (`status`,`requested_start`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_entries_unique` ON `hr_schedule_entries` (`schedule_version_id`,`employment_id`,`work_date`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_employment_date` ON `hr_schedule_entries` (`employment_id`,`work_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_scope_date` ON `hr_schedule_entries` (`scope_id`,`work_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_policy_members_start` ON `hr_bonus_policy_members` (`policy_version_id`,`employment_id`,`valid_from`);
--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_policy_members_employment` ON `hr_bonus_policy_members` (`employment_id`,`valid_from`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_closed_employees_run` ON `hr_payroll_closed_employees` (`payroll_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_run_employees_employment` ON `hr_payroll_run_employees` (`employment_id`,`payroll_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslips_run_employment` ON `hr_payslips` (`payroll_run_id`,`employment_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payslips_employment` ON `hr_payslips` (`employment_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_compensation_items_version` ON `hr_compensation_items` (`compensation_version_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslip_lines_key` ON `hr_payslip_lines` (`payslip_id`,`line_key`);
--> statement-breakpoint
CREATE INDEX `idx_hr_annual_leave_entitlement_employee` ON `hr_annual_leave_entitlements` (`employment_id`,`period_end`);
--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_period` ON `hr_leave_requests` (`employment_id`,`starts_on`);
--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_time` ON `hr_leave_requests` (`employment_id`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_leave_type` ON `hr_leave_requests` (`leave_type_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_annual_leave_ledger_source` ON `hr_annual_leave_ledger` (`source_key`);
--> statement-breakpoint
CREATE INDEX `idx_hr_annual_leave_ledger_entitlement` ON `hr_annual_leave_ledger` (`entitlement_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_worker_results_run_worker` ON `hr_payroll_worker_results` (`payroll_run_id`,`worker_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_worker_results_worker` ON `hr_payroll_worker_results` (`worker_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_closed_workers_run` ON `hr_payroll_closed_workers` (`payroll_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_employment_date` ON `hr_special_workday_assignments` (`employment_id`,`work_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_special_workday_assignments_worker_date` ON `hr_special_workday_assignments` (`worker_id`,`work_date`);
--> statement-breakpoint
CREATE INDEX `idx_hr_special_workday_assignments_date` ON `hr_special_workday_assignments` (`work_date`,`employment_id`,`worker_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustments_effective` ON `hr_payroll_adjustments` (`effective_period_key`,`employment_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustment_items_adjustment` ON `hr_payroll_adjustment_items` (`adjustment_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_record_items_record` ON `hr_payroll_record_items` (`payroll_run_id`,`person_kind`,`employment_id`,`worker_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_annual_leave_entitlement_period` ON `hr_annual_leave_entitlements` (`employment_id`,`period_start`,`service_months`,`period_end`);
--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_employee_created` ON `hr_form_requests` (`employee_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_approver_status` ON `hr_form_requests` (`approver_user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_corrected_event` ON `hr_form_requests` (`corrected_clock_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_overtime_unique_request` ON `hr_overtime_requests` (`employment_id`,`requested_start`,`requested_end`) WHERE "hr_overtime_requests"."status" IN ('draft', 'pending', 'approved');
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_group` ON `hr_schedule_entries` (`schedule_version_id`,`shift_group_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_worker_entries_group` ON `hr_schedule_worker_entries` (`schedule_version_id`,`shift_group_id`);
--> statement-breakpoint
CREATE INDEX `idx_hr_worker_overtime_worker_start` ON `hr_worker_overtime_requests` (`worker_id`,`requested_start`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_worker_overtime_unique_request` ON `hr_worker_overtime_requests` (`worker_id`,`requested_start`,`requested_end`) WHERE `status` IN ('draft', 'pending', 'approved');
--> statement-breakpoint
CREATE INDEX `idx_hr_worker_overtime_status` ON `hr_worker_overtime_requests` (`status`,`requested_start`);
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_employments";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_schedule_workers";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_employment_service_periods";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_employee_scopes";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_clock_events";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_employee_attendance_locations";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_employment_attendance_settings";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_compensation_versions";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_insurance_versions";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_monthly_hourly_entries";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_monthly_leave_entries";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_overtime_requests";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_schedule_entries";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_bonus_policy_members";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_closed_employees";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_run_employees";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payslips";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_annual_leave_entitlements";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_leave_requests";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_special_workday_assignments";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_adjustments";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_record_items";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_form_requests";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_worker_compensation_versions";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_schedule_worker_entries";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_worker_results";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_closed_workers";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_worker_overtime_requests";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_compensation_items";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payslip_compensation_links";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payslip_insurance_links";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payslip_lines";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_annual_leave_ledger";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_hr_payroll_adjustment_items";
--> statement-breakpoint
DROP TRIGGER "__hr_unify_0220_employee_number_collision";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_employee_numbers";
--> statement-breakpoint
DROP TRIGGER "__hr_unify_0220_employment_id_collision";
--> statement-breakpoint
DROP TABLE "__hr_unify_0220_employment_ids";
--> statement-breakpoint
-- 支援人員的舊主檔繼續保留穩定 ID；canonical row 才是排班、敘薪、特殊日、加班與薪資結果的外鍵 parent。