CREATE TABLE `hr_calendar_day_scopes` (
	`date` text NOT NULL,
	`scope_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`date`, `scope_id`),
	FOREIGN KEY (`date`) REFERENCES `hr_calendar_days`(`date`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_hr_calendar_day_scopes_scope` ON `hr_calendar_day_scopes` (`scope_id`,`date`);