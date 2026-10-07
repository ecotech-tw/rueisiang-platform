PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hr_shift_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`required_headcount` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_shift_templates_code" CHECK(length(trim("__new_hr_shift_templates"."code")) BETWEEN 1 AND 40),
	CONSTRAINT "ck_hr_shift_templates_name" CHECK(length(trim("__new_hr_shift_templates"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_shift_templates_active" CHECK("__new_hr_shift_templates"."active" IN (0, 1)),
	CONSTRAINT "ck_hr_shift_templates_headcount" CHECK("__new_hr_shift_templates"."required_headcount" BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_shift_templates_revision" CHECK("__new_hr_shift_templates"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_shift_templates`("id", "code", "name", "active", "required_headcount", "created_by", "created_at", "updated_at", "revision") SELECT "id", "code", "name", "active", "required_headcount", "created_by", "created_at", "updated_at", "revision" FROM `hr_shift_templates`;--> statement-breakpoint
DROP TABLE `hr_shift_templates`;--> statement-breakpoint
ALTER TABLE `__new_hr_shift_templates` RENAME TO `hr_shift_templates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_shift_templates_code` ON `hr_shift_templates` (`code`);