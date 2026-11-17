CREATE TABLE `hr_employee_rfid_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`card_code` text NOT NULL,
	`protocol_code` text NOT NULL,
	`linked_by` text NOT NULL,
	`linked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_by` text,
	`revoked_at` text,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`linked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_rfid_cards_code" CHECK(length("hr_employee_rfid_cards"."card_code") = 8 AND "hr_employee_rfid_cards"."card_code" NOT GLOB '*[^0-9A-F]*'),
	CONSTRAINT "ck_hr_employee_rfid_cards_protocol" CHECK("hr_employee_rfid_cards"."protocol_code" = '0002'),
	CONSTRAINT "ck_hr_employee_rfid_cards_revocation" CHECK(("hr_employee_rfid_cards"."revoked_at" IS NULL AND "hr_employee_rfid_cards"."revoked_by" IS NULL) OR ("hr_employee_rfid_cards"."revoked_at" IS NOT NULL AND "hr_employee_rfid_cards"."revoked_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_rfid_cards_active_code` ON `hr_employee_rfid_cards` (`card_code`) WHERE "hr_employee_rfid_cards"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_rfid_cards_active_employment` ON `hr_employee_rfid_cards` (`employment_id`) WHERE "hr_employee_rfid_cards"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_hr_employee_rfid_cards_employment` ON `hr_employee_rfid_cards` (`employment_id`,`linked_at`);--> statement-breakpoint
CREATE TABLE `hr_rfid_enrollment_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`status` text NOT NULL,
	`candidate_card_code` text,
	`candidate_protocol_code` text,
	`device_id` text,
	`started_by` text NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`scanned_at` text,
	`finished_at` text,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_rfid_enrollment_status" CHECK("hr_rfid_enrollment_sessions"."status" IN ('listening', 'captured', 'confirmed', 'cancelled', 'expired')),
	CONSTRAINT "ck_hr_rfid_enrollment_candidate" CHECK(("hr_rfid_enrollment_sessions"."candidate_card_code" IS NULL AND "hr_rfid_enrollment_sessions"."candidate_protocol_code" IS NULL) OR (length("hr_rfid_enrollment_sessions"."candidate_card_code") = 8 AND "hr_rfid_enrollment_sessions"."candidate_card_code" NOT GLOB '*[^0-9A-F]*' AND "hr_rfid_enrollment_sessions"."candidate_protocol_code" = '0002')),
	CONSTRAINT "ck_hr_rfid_enrollment_device" CHECK("hr_rfid_enrollment_sessions"."device_id" IS NULL OR length(trim("hr_rfid_enrollment_sessions"."device_id")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_rfid_enrollment_one_listener` ON `hr_rfid_enrollment_sessions` (`status`) WHERE "hr_rfid_enrollment_sessions"."status" = 'listening';--> statement-breakpoint
CREATE INDEX `idx_hr_rfid_enrollment_employment` ON `hr_rfid_enrollment_sessions` (`employment_id`,`started_at`);