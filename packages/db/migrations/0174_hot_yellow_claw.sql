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
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
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
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
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
ALTER TABLE `hr_employments` ADD `employee_number` text;--> statement-breakpoint
ALTER TABLE `hr_employments` ADD `position` text DEFAULT '一般職員' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_employments` ADD `supervisor_user_id` text;--> statement-breakpoint
ALTER TABLE `hr_employments` ADD `archived_at` text;