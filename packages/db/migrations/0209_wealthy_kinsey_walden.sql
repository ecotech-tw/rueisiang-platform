PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "ck_hr_form_requests_status" CHECK("__new_hr_form_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_form_requests_event_kind" CHECK("__new_hr_form_requests"."requested_event_kind" IN ('clock_in', 'clock_out')),
	CONSTRAINT "ck_hr_form_requests_date" CHECK(length("__new_hr_form_requests"."correction_date") = 10),
	CONSTRAINT "ck_hr_form_requests_reason" CHECK(length(trim("__new_hr_form_requests"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_form_requests`("id", "employee_user_id", "employment_id", "form_kind", "status", "correction_date", "requested_event_kind", "requested_at", "reason", "approver_user_id", "submitted_at", "reviewed_at", "review_comment", "corrected_clock_event_id", "created_at", "updated_at") SELECT "id", "employee_user_id", "employment_id", "form_kind", "status", "correction_date", "requested_event_kind", "requested_at", "reason", "approver_user_id", "submitted_at", "reviewed_at", "review_comment", "corrected_clock_event_id", "created_at", "updated_at" FROM `hr_form_requests`;--> statement-breakpoint
DROP TABLE `hr_form_requests`;--> statement-breakpoint
ALTER TABLE `__new_hr_form_requests` RENAME TO `hr_form_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_employee_created` ON `hr_form_requests` (`employee_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_approver_status` ON `hr_form_requests` (`approver_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_corrected_event` ON `hr_form_requests` (`corrected_clock_event_id`);