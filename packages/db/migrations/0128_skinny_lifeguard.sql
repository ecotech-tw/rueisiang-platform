CREATE TABLE `hr_attendance_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`geolocation_required` integer DEFAULT 1 NOT NULL,
	`latitude_e7` integer,
	`longitude_e7` integer,
	`radius_meters` integer DEFAULT 50 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ck_hr_attendance_locations_name" CHECK(length(trim("hr_attendance_locations"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_attendance_locations_geo_required" CHECK("hr_attendance_locations"."geolocation_required" IN (0, 1)),
	CONSTRAINT "ck_hr_attendance_locations_active" CHECK("hr_attendance_locations"."active" IN (0, 1)),
	CONSTRAINT "ck_hr_attendance_locations_radius" CHECK("hr_attendance_locations"."radius_meters" BETWEEN 1 AND 10000),
	CONSTRAINT "ck_hr_attendance_locations_latitude" CHECK("hr_attendance_locations"."latitude_e7" IS NULL OR "hr_attendance_locations"."latitude_e7" BETWEEN -900000000 AND 900000000),
	CONSTRAINT "ck_hr_attendance_locations_longitude" CHECK("hr_attendance_locations"."longitude_e7" IS NULL OR "hr_attendance_locations"."longitude_e7" BETWEEN -1800000000 AND 1800000000),
	CONSTRAINT "ck_hr_attendance_locations_geo_pair" CHECK(("hr_attendance_locations"."geolocation_required" = 0) OR ("hr_attendance_locations"."latitude_e7" IS NOT NULL AND "hr_attendance_locations"."longitude_e7" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_attendance_locations_name` ON `hr_attendance_locations` (`name`);--> statement-breakpoint
CREATE INDEX `idx_hr_attendance_locations_active` ON `hr_attendance_locations` (`active`,`name`);--> statement-breakpoint
CREATE TABLE `hr_employee_attendance_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`location_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_attendance_locations_dates" CHECK(length("hr_employee_attendance_locations"."valid_from") = 10 AND ("hr_employee_attendance_locations"."valid_to" IS NULL OR (length("hr_employee_attendance_locations"."valid_to") = 10 AND "hr_employee_attendance_locations"."valid_to" > "hr_employee_attendance_locations"."valid_from"))),
	CONSTRAINT "ck_hr_employee_attendance_locations_revision" CHECK("hr_employee_attendance_locations"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_attendance_locations_start` ON `hr_employee_attendance_locations` (`employment_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_hr_employee_attendance_locations_location` ON `hr_employee_attendance_locations` (`location_id`,`valid_from`);