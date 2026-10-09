DROP INDEX `idx_hr_schedule_entries_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_entries_unique` ON `hr_schedule_entries` (`schedule_version_id`,`employment_id`,`scope_id`,`work_date`,`starts_at`);--> statement-breakpoint
DROP INDEX `idx_hr_schedule_worker_entries_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_worker_entries_unique` ON `hr_schedule_worker_entries` (`schedule_version_id`,`worker_id`,`scope_id`,`work_date`,`starts_at`);