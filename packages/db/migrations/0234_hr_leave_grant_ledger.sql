CREATE TABLE `hr_leave_grant_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`leave_type_id` text NOT NULL,
	`issued_on` text NOT NULL,
	`expires_on` text NOT NULL,
	`amount_minutes` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_grant_batches_dates" CHECK(length("hr_leave_grant_batches"."issued_on") = 10 AND length("hr_leave_grant_batches"."expires_on") = 10 AND "hr_leave_grant_batches"."expires_on" >= "hr_leave_grant_batches"."issued_on"),
	CONSTRAINT "ck_hr_leave_grant_batches_amount" CHECK("hr_leave_grant_batches"."amount_minutes" > 0 AND "hr_leave_grant_batches"."amount_minutes" % 60 = 0),
	CONSTRAINT "ck_hr_leave_grant_batches_note" CHECK(length("hr_leave_grant_batches"."note") <= 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_leave_grant_batches_type_date` ON `hr_leave_grant_batches` (`leave_type_id`,`issued_on`,`expires_on`);--> statement-breakpoint
CREATE TABLE `hr_leave_grant_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`entry_kind` text NOT NULL,
	`delta_minutes` integer NOT NULL,
	`source_key` text NOT NULL,
	`leave_request_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `hr_leave_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_request_id`) REFERENCES `hr_leave_requests`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_grant_ledger_kind" CHECK("hr_leave_grant_ledger"."entry_kind" IN ('grant', 'leave_request', 'leave_request_reversal', 'revocation')),
	CONSTRAINT "ck_hr_leave_grant_ledger_delta" CHECK("hr_leave_grant_ledger"."delta_minutes" <> 0),
	CONSTRAINT "ck_hr_leave_grant_ledger_note" CHECK(length("hr_leave_grant_ledger"."note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_leave_grant_ledger_source` ON `hr_leave_grant_ledger` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_hr_leave_grant_ledger_grant` ON `hr_leave_grant_ledger` (`grant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_leave_grant_ledger_request` ON `hr_leave_grant_ledger` (`leave_request_id`);--> statement-breakpoint
CREATE TABLE `hr_leave_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`employment_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `hr_leave_grant_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_grants_status" CHECK("hr_leave_grants"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_leave_grants_batch_employment` ON `hr_leave_grants` (`batch_id`,`employment_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_leave_grants_employment` ON `hr_leave_grants` (`employment_id`,`status`);