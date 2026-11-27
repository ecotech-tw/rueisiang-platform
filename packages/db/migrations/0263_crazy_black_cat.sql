CREATE TABLE `accounting_petty_cash_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`expense_id` text,
	`note` text DEFAULT '' NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `accounting_expenses`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_accounting_petty_cash_kind" CHECK("accounting_petty_cash_entries"."kind" IN ('top_up', 'payout', 'refund')),
	CONSTRAINT "ck_accounting_petty_cash_sign" CHECK(("accounting_petty_cash_entries"."kind" IN ('top_up', 'refund') AND "accounting_petty_cash_entries"."amount_minor" > 0) OR ("accounting_petty_cash_entries"."kind" = 'payout' AND "accounting_petty_cash_entries"."amount_minor" < 0)),
	CONSTRAINT "ck_accounting_petty_cash_expense" CHECK(("accounting_petty_cash_entries"."kind" IN ('payout', 'refund')) = ("accounting_petty_cash_entries"."expense_id" IS NOT NULL)),
	CONSTRAINT "ck_accounting_petty_cash_note" CHECK(length("accounting_petty_cash_entries"."note") <= 500)
);
--> statement-breakpoint
CREATE INDEX `idx_accounting_petty_cash_created` ON `accounting_petty_cash_entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_accounting_petty_cash_expense` ON `accounting_petty_cash_entries` (`expense_id`);