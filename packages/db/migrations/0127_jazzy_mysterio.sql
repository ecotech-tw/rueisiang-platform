CREATE TABLE `hr_employee_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employee_scopes_dates" CHECK(length("hr_employee_scopes"."valid_from") = 10 AND ("hr_employee_scopes"."valid_to" IS NULL OR (length("hr_employee_scopes"."valid_to") = 10 AND "hr_employee_scopes"."valid_to" > "hr_employee_scopes"."valid_from"))),
	CONSTRAINT "ck_hr_employee_scopes_revision" CHECK("hr_employee_scopes"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employee_scopes_start` ON `hr_employee_scopes` (`employment_id`,`scope_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `idx_hr_employee_scopes_scope` ON `hr_employee_scopes` (`scope_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `hr_employees` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_number` text NOT NULL,
	`display_name` text NOT NULL,
	`user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employees_number" CHECK(length(trim("hr_employees"."employee_number")) BETWEEN 1 AND 40),
	CONSTRAINT "ck_hr_employees_name" CHECK(length(trim("hr_employees"."display_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_employees_revision" CHECK("hr_employees"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employees_number` ON `hr_employees` (`employee_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employees_user` ON `hr_employees` (`user_id`);--> statement-breakpoint
CREATE TABLE `hr_employers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`registration_number` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ck_hr_employers_name" CHECK(length(trim("hr_employers"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_employers_registration" CHECK("hr_employers"."registration_number" IS NULL OR (length("hr_employers"."registration_number") = 8 AND "hr_employers"."registration_number" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "ck_hr_employers_revision" CHECK("hr_employers"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employers_registration` ON `hr_employers` (`registration_number`);--> statement-breakpoint
CREATE TABLE `hr_employments` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`employer_id` text NOT NULL,
	`hired_on` text NOT NULL,
	`ended_on` text,
	`seniority_start_on` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `hr_employees`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employer_id`) REFERENCES `hr_employers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_employments_dates" CHECK(length("hr_employments"."hired_on") = 10 AND length("hr_employments"."seniority_start_on") = 10 AND ("hr_employments"."ended_on" IS NULL OR (length("hr_employments"."ended_on") = 10 AND "hr_employments"."ended_on" > "hr_employments"."hired_on")) AND "hr_employments"."seniority_start_on" <= "hr_employments"."hired_on"),
	CONSTRAINT "ck_hr_employments_revision" CHECK("hr_employments"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_employments_start` ON `hr_employments` (`employee_id`,`employer_id`,`hired_on`);--> statement-breakpoint
CREATE INDEX `idx_hr_employments_employer` ON `hr_employments` (`employer_id`,`hired_on`);