CREATE TABLE `accounting_expense_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ck_accounting_expense_categories_name" CHECK(length(trim("accounting_expense_categories"."name")) BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounting_expense_categories_name_unique` ON `accounting_expense_categories` (`name`);--> statement-breakpoint
CREATE TABLE `accounting_expense_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `accounting_expenses`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_accounting_expense_receipts_type" CHECK("accounting_expense_receipts"."content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "ck_accounting_expense_receipts_size" CHECK("accounting_expense_receipts"."byte_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounting_expense_receipts_object_key_unique` ON `accounting_expense_receipts` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expense_receipts_expense` ON `accounting_expense_receipts` (`expense_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `accounting_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`payer_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitter_user_id` text NOT NULL,
	`employment_id` text,
	`client_request_id` text NOT NULL,
	`category_id` text NOT NULL,
	`scope_id` text,
	`spent_on` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`invoice_number` text DEFAULT '' NOT NULL,
	`seller_tax_id` text DEFAULT '' NOT NULL,
	`description` text NOT NULL,
	`payout_method` text,
	`reviewer_user_id` text,
	`reviewed_at` text,
	`review_note` text DEFAULT '' NOT NULL,
	`paid_at` text,
	`payroll_adjustment_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submitter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `accounting_expense_categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payroll_adjustment_id`) REFERENCES `hr_payroll_adjustments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_accounting_expenses_payer_kind" CHECK("accounting_expenses"."payer_kind" IN ('employee_advance', 'company')),
	CONSTRAINT "ck_accounting_expenses_status" CHECK("accounting_expenses"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'paid')),
	CONSTRAINT "ck_accounting_expenses_employment" CHECK(("accounting_expenses"."payer_kind" = 'employee_advance') = ("accounting_expenses"."employment_id" IS NOT NULL)),
	CONSTRAINT "ck_accounting_expenses_spent_on" CHECK("accounting_expenses"."spent_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_accounting_expenses_amount" CHECK("accounting_expenses"."amount_minor" > 0),
	CONSTRAINT "ck_accounting_expenses_description" CHECK(length(trim("accounting_expenses"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "ck_accounting_expenses_payout_method" CHECK("accounting_expenses"."payout_method" IS NULL OR "accounting_expenses"."payout_method" IN ('direct', 'payroll')),
	CONSTRAINT "ck_accounting_expenses_payroll_link" CHECK("accounting_expenses"."payroll_adjustment_id" IS NULL OR "accounting_expenses"."payout_method" = 'payroll'),
	CONSTRAINT "ck_accounting_expenses_revision" CHECK("accounting_expenses"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounting_expenses_client_request` ON `accounting_expenses` (`submitter_user_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expenses_submitter_created` ON `accounting_expenses` (`submitter_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expenses_status_created` ON `accounting_expenses` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expenses_invoice` ON `accounting_expenses` (`invoice_number`) WHERE "accounting_expenses"."invoice_number" <> '';