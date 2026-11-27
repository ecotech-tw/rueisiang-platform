-- 讓沒綁定 LINE 的人也能送報帳：accounting_expenses 放寬 submitter_user_id NOT NULL 與任職資料的 CHECK，新增送件管道與 LINE 欄位。
-- SQLite 改不了 NOT NULL／CHECK，只能重建；但單據照片與零用金紀錄都用 RESTRICT 外鍵指著它，D1 的單一 transaction 裡
-- PRAGMA foreign_keys=OFF 無效，DROP 父表會被子表擋下。所以照 CLAUDE.md 第三種窄例外，三張表一起重建：
-- 先建 __new_ 版本（子表指向 __new_ 父表）、搬資料、先刪舊子表再刪舊父表、改名（SQLite 會改寫外鍵裡的表名），
-- 最後補回索引與零用金的守門 trigger（DROP TABLE 會一併刪掉；DROP 的隱含 DELETE 不會觸發 trigger）。
-- accounting_expenses 的建表語句就是 Drizzle 產的那份；子表照原本的 DDL，只把外鍵與 CHECK 指向 __new_ 名稱。
CREATE TABLE `__new_accounting_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`payer_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`submitter_user_id` text,
	`source` text DEFAULT 'platform' NOT NULL,
	`line_user_id` text,
	`line_display_name` text DEFAULT '' NOT NULL,
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
	CONSTRAINT "ck_accounting_expenses_payer_kind" CHECK("__new_accounting_expenses"."payer_kind" IN ('employee_advance', 'company')),
	CONSTRAINT "ck_accounting_expenses_status" CHECK("__new_accounting_expenses"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'paid')),
	CONSTRAINT "ck_accounting_expenses_source" CHECK("__new_accounting_expenses"."source" IN ('platform', 'line')),
	CONSTRAINT "ck_accounting_expenses_submitter" CHECK("__new_accounting_expenses"."submitter_user_id" IS NOT NULL OR ("__new_accounting_expenses"."source" = 'line' AND "__new_accounting_expenses"."payer_kind" = 'employee_advance' AND "__new_accounting_expenses"."line_user_id" IS NOT NULL AND length(trim("__new_accounting_expenses"."line_display_name")) > 0)),
	CONSTRAINT "ck_accounting_expenses_employment" CHECK(("__new_accounting_expenses"."payer_kind" = 'employee_advance' AND "__new_accounting_expenses"."submitter_user_id" IS NOT NULL) = ("__new_accounting_expenses"."employment_id" IS NOT NULL)),
	CONSTRAINT "ck_accounting_expenses_guest_payout" CHECK("__new_accounting_expenses"."submitter_user_id" IS NOT NULL OR "__new_accounting_expenses"."payout_method" IS NULL OR "__new_accounting_expenses"."payout_method" = 'direct'),
	CONSTRAINT "ck_accounting_expenses_spent_on" CHECK("__new_accounting_expenses"."spent_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_accounting_expenses_amount" CHECK("__new_accounting_expenses"."amount_minor" > 0),
	CONSTRAINT "ck_accounting_expenses_description" CHECK(length(trim("__new_accounting_expenses"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "ck_accounting_expenses_payout_method" CHECK("__new_accounting_expenses"."payout_method" IS NULL OR "__new_accounting_expenses"."payout_method" IN ('direct', 'payroll')),
	CONSTRAINT "ck_accounting_expenses_payroll_link" CHECK("__new_accounting_expenses"."payroll_adjustment_id" IS NULL OR "__new_accounting_expenses"."payout_method" = 'payroll'),
	CONSTRAINT "ck_accounting_expenses_revision" CHECK("__new_accounting_expenses"."revision" > 0)
);--> statement-breakpoint
INSERT INTO `__new_accounting_expenses` (`id`, `payer_kind`, `status`, `submitter_user_id`, `employment_id`, `client_request_id`, `category_id`, `scope_id`, `spent_on`, `amount_minor`, `invoice_number`, `seller_tax_id`, `description`, `payout_method`, `reviewer_user_id`, `reviewed_at`, `review_note`, `paid_at`, `payroll_adjustment_id`, `revision`, `created_at`, `updated_at`) SELECT `id`, `payer_kind`, `status`, `submitter_user_id`, `employment_id`, `client_request_id`, `category_id`, `scope_id`, `spent_on`, `amount_minor`, `invoice_number`, `seller_tax_id`, `description`, `payout_method`, `reviewer_user_id`, `reviewed_at`, `review_note`, `paid_at`, `payroll_adjustment_id`, `revision`, `created_at`, `updated_at` FROM `accounting_expenses`;--> statement-breakpoint
CREATE TABLE `__new_accounting_expense_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `__new_accounting_expenses`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_accounting_expense_receipts_type" CHECK("__new_accounting_expense_receipts"."content_type" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "ck_accounting_expense_receipts_size" CHECK("__new_accounting_expense_receipts"."byte_size" > 0)
);--> statement-breakpoint
INSERT INTO `__new_accounting_expense_receipts` (`id`, `expense_id`, `object_key`, `content_type`, `byte_size`, `sort_order`, `created_at`)
  SELECT `id`, `expense_id`, `object_key`, `content_type`, `byte_size`, `sort_order`, `created_at` FROM `accounting_expense_receipts`;--> statement-breakpoint
CREATE TABLE `__new_accounting_petty_cash_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`expense_id` text,
	`corrects_entry_id` text,
	`note` text DEFAULT '' NOT NULL,
	`actor_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`expense_id`) REFERENCES `__new_accounting_expenses`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`corrects_entry_id`) REFERENCES `__new_accounting_petty_cash_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_accounting_petty_cash_kind" CHECK("__new_accounting_petty_cash_entries"."kind" IN ('top_up', 'payout', 'refund', 'correction')),
	CONSTRAINT "ck_accounting_petty_cash_sign" CHECK(("__new_accounting_petty_cash_entries"."kind" IN ('top_up', 'refund') AND "__new_accounting_petty_cash_entries"."amount_minor" > 0) OR ("__new_accounting_petty_cash_entries"."kind" = 'payout' AND "__new_accounting_petty_cash_entries"."amount_minor" < 0) OR ("__new_accounting_petty_cash_entries"."kind" = 'correction' AND "__new_accounting_petty_cash_entries"."amount_minor" <> 0)),
	CONSTRAINT "ck_accounting_petty_cash_expense" CHECK(("__new_accounting_petty_cash_entries"."kind" IN ('payout', 'refund')) = ("__new_accounting_petty_cash_entries"."expense_id" IS NOT NULL)),
	CONSTRAINT "ck_accounting_petty_cash_correction" CHECK(("__new_accounting_petty_cash_entries"."kind" = 'correction') = ("__new_accounting_petty_cash_entries"."corrects_entry_id" IS NOT NULL)),
	CONSTRAINT "ck_accounting_petty_cash_note" CHECK(length("__new_accounting_petty_cash_entries"."note") <= 500 AND ("__new_accounting_petty_cash_entries"."kind" <> 'correction' OR length(trim("__new_accounting_petty_cash_entries"."note")) > 0))
);--> statement-breakpoint
-- 照原本的寫入順序搬：零用金清單同一秒的紀錄靠 rowid 排序，更正也一定排在它更正的那筆後面。
INSERT INTO `__new_accounting_petty_cash_entries` (`id`, `kind`, `amount_minor`, `expense_id`, `corrects_entry_id`, `note`, `actor_user_id`, `created_at`)
  SELECT `id`, `kind`, `amount_minor`, `expense_id`, `corrects_entry_id`, `note`, `actor_user_id`, `created_at` FROM `accounting_petty_cash_entries` ORDER BY rowid;--> statement-breakpoint
-- 舊的零用金表自己指著自己（更正 → 被更正的增加，RESTRICT）：DROP 的隱含 DELETE 若先刪到被更正的那筆就會被擋。
-- 資料已經搬進新表，先拿掉舊表擋刪除的 trigger，把更正先刪掉，再刪表；新表的 trigger 最後補回。
DROP TRIGGER `trg_accounting_petty_cash_no_delete`;--> statement-breakpoint
DELETE FROM `accounting_petty_cash_entries` WHERE `corrects_entry_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `accounting_petty_cash_entries`;--> statement-breakpoint
DROP TABLE `accounting_expense_receipts`;--> statement-breakpoint
DROP TABLE `accounting_expenses`;--> statement-breakpoint
ALTER TABLE `__new_accounting_expenses` RENAME TO `accounting_expenses`;--> statement-breakpoint
ALTER TABLE `__new_accounting_expense_receipts` RENAME TO `accounting_expense_receipts`;--> statement-breakpoint
ALTER TABLE `__new_accounting_petty_cash_entries` RENAME TO `accounting_petty_cash_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounting_expenses_client_request` ON `accounting_expenses` (`submitter_user_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounting_expenses_line_request` ON `accounting_expenses` (`client_request_id`) WHERE "accounting_expenses"."source" = 'line';--> statement-breakpoint
CREATE INDEX `idx_accounting_expenses_submitter_created` ON `accounting_expenses` (`submitter_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expenses_status_created` ON `accounting_expenses` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expenses_invoice` ON `accounting_expenses` (`invoice_number`) WHERE "accounting_expenses"."invoice_number" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `accounting_expense_receipts_object_key_unique` ON `accounting_expense_receipts` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_accounting_expense_receipts_expense` ON `accounting_expense_receipts` (`expense_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_accounting_petty_cash_created` ON `accounting_petty_cash_entries` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_accounting_petty_cash_expense` ON `accounting_petty_cash_entries` (`expense_id`);--> statement-breakpoint
CREATE INDEX `idx_accounting_petty_cash_corrects` ON `accounting_petty_cash_entries` (`corrects_entry_id`);--> statement-breakpoint
CREATE TRIGGER `trg_accounting_petty_cash_no_update`
BEFORE UPDATE ON `accounting_petty_cash_entries`
BEGIN
  SELECT RAISE(ABORT, 'petty_cash_entries_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `trg_accounting_petty_cash_no_delete`
BEFORE DELETE ON `accounting_petty_cash_entries`
BEGIN
  SELECT RAISE(ABORT, 'petty_cash_entries_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `trg_accounting_petty_cash_not_negative`
BEFORE INSERT ON `accounting_petty_cash_entries`
WHEN NEW.`amount_minor` < 0
  AND (SELECT coalesce(sum(`amount_minor`), 0) FROM `accounting_petty_cash_entries`) + NEW.`amount_minor` < 0
BEGIN
  SELECT RAISE(ABORT, 'petty_cash_balance_negative');
END;
