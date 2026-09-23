CREATE TABLE `hr_employment_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_user_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`action_kind` text NOT NULL,
	`before_ended_on` text,
	`after_ended_on` text,
	`expected_revision` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`undone_at` text,
	`undone_by` text,
	CONSTRAINT "ck_hr_employment_actions_kind" CHECK("hr_employment_actions"."action_kind" IN ('employee_assigned', 'employment_created', 'employment_ended')),
	CONSTRAINT "ck_hr_employment_actions_revision" CHECK("hr_employment_actions"."expected_revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_employment_actions_employee_created` ON `hr_employment_actions` (`employee_user_id`,`created_at`);