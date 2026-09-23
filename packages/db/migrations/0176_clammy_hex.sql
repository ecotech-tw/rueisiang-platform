CREATE TABLE `hr_employments_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_user_id` text NOT NULL,
	`employee_number` text NOT NULL,
	`position` text DEFAULT '一般職員' NOT NULL,
	`supervisor_user_id` text,
	`archived_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`supervisor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employments_number" CHECK(length(trim("hr_employments_v2"."employee_number")) BETWEEN 1 AND 40),
	CONSTRAINT "ck_hr_employments_position" CHECK(length(trim("hr_employments_v2"."position")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_employments_revision" CHECK("hr_employments_v2"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employments_active_user` ON `hr_employments_v2` (`employee_user_id`) WHERE "hr_employments_v2"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employments_active_number` ON `hr_employments_v2` (`employee_number`) WHERE "hr_employments_v2"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_hr_employments_archived` ON `hr_employments_v2` (`archived_at`);