CREATE TABLE `hr_employee_photos` (
	`employment_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_photos_content_type" CHECK("hr_employee_photos"."content_type" IN ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_photos_object_key` ON `hr_employee_photos` (`object_key`);