CREATE TABLE `hr_clock_events` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_user_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`attendance_location_id` text,
	`source_kind` text DEFAULT 'portal' NOT NULL,
	`idempotency_key` text NOT NULL,
	`event_kind` text NOT NULL,
	`latitude_e7` integer,
	`longitude_e7` integer,
	`distance_meters` integer,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employee_user_id`) REFERENCES `hr_employees`(`user_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attendance_location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_clock_events_source" CHECK("hr_clock_events"."source_kind" IN ('portal', 'rfid', 'line', 'manual')),
	CONSTRAINT "ck_hr_clock_events_kind" CHECK("hr_clock_events"."event_kind" IN ('clock_in', 'clock_out')),
	CONSTRAINT "ck_hr_clock_events_coordinate_pair" CHECK(("hr_clock_events"."latitude_e7" IS NULL AND "hr_clock_events"."longitude_e7" IS NULL) OR ("hr_clock_events"."latitude_e7" IS NOT NULL AND "hr_clock_events"."longitude_e7" IS NOT NULL)),
	CONSTRAINT "ck_hr_clock_events_latitude" CHECK("hr_clock_events"."latitude_e7" IS NULL OR "hr_clock_events"."latitude_e7" BETWEEN -900000000 AND 900000000),
	CONSTRAINT "ck_hr_clock_events_longitude" CHECK("hr_clock_events"."longitude_e7" IS NULL OR "hr_clock_events"."longitude_e7" BETWEEN -1800000000 AND 1800000000),
	CONSTRAINT "ck_hr_clock_events_distance" CHECK("hr_clock_events"."distance_meters" IS NULL OR "hr_clock_events"."distance_meters" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_clock_events_idempotency` ON `hr_clock_events` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_hr_clock_events_employee_occurred` ON `hr_clock_events` (`employee_user_id`,`occurred_at`);