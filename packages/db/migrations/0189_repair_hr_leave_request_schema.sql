-- 0170–0188 曾在正式庫以不同批次順序套用；0178 重建申請表時把後來才加入的
-- leave_type_id、starts_at、ends_at 一起覆蓋掉。這支 migration 不假設目前表的
-- 欄位版本，重建申請表與唯一的 restrict 子表，讓兩種歷史順序最後回到同一個 schema。
--
-- 不使用 PRAGMA foreign_keys=OFF：先搬開 ledger 的外鍵，再建立新表，避免
-- DROP 父表時遺失或連坐刪除資料。
ALTER TABLE `hr_annual_leave_ledger` RENAME TO `__repair_hr_annual_leave_ledger`;--> statement-breakpoint
ALTER TABLE `hr_leave_requests` RENAME TO `__repair_hr_leave_requests`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_hr_leave_requests_employment_period`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_hr_leave_requests_employment_time`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_hr_leave_requests_leave_type`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_hr_annual_leave_ledger_source`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_hr_annual_leave_ledger_entitlement`;--> statement-breakpoint
CREATE TABLE `hr_leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`leave_type_id` text,
	`leave_type` text NOT NULL,
	`status` text NOT NULL,
	`starts_at` text DEFAULT '' NOT NULL,
	`ends_at` text DEFAULT '' NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`pay_rate_ppm` integer DEFAULT 1000000 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`review_comment` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_type_id`) REFERENCES `hr_leave_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_leave_requests_type" CHECK(length(trim("hr_leave_requests"."leave_type")) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_leave_requests_status" CHECK("hr_leave_requests"."status" IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "ck_hr_leave_requests_dates" CHECK(length("hr_leave_requests"."starts_on") = 10 AND length("hr_leave_requests"."ends_on") = 10 AND "hr_leave_requests"."ends_on" > "hr_leave_requests"."starts_on"),
	CONSTRAINT "ck_hr_leave_requests_duration" CHECK("hr_leave_requests"."duration_minutes" > 0),
	CONSTRAINT "ck_hr_leave_requests_pay_rate" CHECK("hr_leave_requests"."pay_rate_ppm" BETWEEN 0 AND 1000000),
	CONSTRAINT "ck_hr_leave_requests_reason" CHECK(length("hr_leave_requests"."reason") <= 1000)
);--> statement-breakpoint
-- 舊表若已經有這些欄位，trigger 先保留原值；欄位不存在時 WHEN 為 false，
-- SQLite 不會執行 body，才能同時相容兩種正式庫歷史順序。
CREATE TRIGGER `__repair_hr_leave_requests_copy_leave_type_id`
AFTER INSERT ON `hr_leave_requests`
WHEN EXISTS (SELECT 1 FROM pragma_table_info('__repair_hr_leave_requests') WHERE name = 'leave_type_id')
BEGIN
	UPDATE `hr_leave_requests`
	SET `leave_type_id` = (SELECT `leave_type_id` FROM `__repair_hr_leave_requests` WHERE `id` = NEW.`id`)
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `__repair_hr_leave_requests_copy_starts_at`
AFTER INSERT ON `hr_leave_requests`
WHEN EXISTS (SELECT 1 FROM pragma_table_info('__repair_hr_leave_requests') WHERE name = 'starts_at')
BEGIN
	UPDATE `hr_leave_requests`
	SET `starts_at` = (SELECT `starts_at` FROM `__repair_hr_leave_requests` WHERE `id` = NEW.`id`)
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `__repair_hr_leave_requests_copy_ends_at`
AFTER INSERT ON `hr_leave_requests`
WHEN EXISTS (SELECT 1 FROM pragma_table_info('__repair_hr_leave_requests') WHERE name = 'ends_at')
BEGIN
	UPDATE `hr_leave_requests`
	SET `ends_at` = (SELECT `ends_at` FROM `__repair_hr_leave_requests` WHERE `id` = NEW.`id`)
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
INSERT INTO `hr_leave_requests` (
	`id`, `employment_id`, `leave_type`, `status`, `starts_on`, `ends_on`,
	`duration_minutes`, `pay_rate_ppm`, `reason`, `reviewed_by`, `reviewed_at`,
	`review_comment`, `created_at`, `created_by`
)
SELECT
	`id`, `employment_id`, `leave_type`, `status`, `starts_on`, `ends_on`,
	`duration_minutes`, `pay_rate_ppm`, `reason`, `reviewed_by`, `reviewed_at`,
	`review_comment`, `created_at`, `created_by`
FROM `__repair_hr_leave_requests`;--> statement-breakpoint
DROP TRIGGER `__repair_hr_leave_requests_copy_leave_type_id`;--> statement-breakpoint
DROP TRIGGER `__repair_hr_leave_requests_copy_starts_at`;--> statement-breakpoint
DROP TRIGGER `__repair_hr_leave_requests_copy_ends_at`;--> statement-breakpoint
CREATE TABLE `hr_annual_leave_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`entitlement_id` text NOT NULL,
	`entry_kind` text NOT NULL,
	`delta_half_hours` integer NOT NULL,
	`source_key` text NOT NULL,
	`leave_request_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entitlement_id`) REFERENCES `hr_annual_leave_entitlements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_request_id`) REFERENCES `hr_leave_requests`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_ledger_kind" CHECK("hr_annual_leave_ledger"."entry_kind" IN ('grant', 'leave_request', 'manual_adjustment', 'settlement', 'settlement_reversal')),
	CONSTRAINT "ck_hr_annual_leave_ledger_delta" CHECK("hr_annual_leave_ledger"."delta_half_hours" <> 0),
	CONSTRAINT "ck_hr_annual_leave_ledger_note" CHECK(length("hr_annual_leave_ledger"."note") <= 1000)
);--> statement-breakpoint
INSERT INTO `hr_annual_leave_ledger` (
	`id`, `entitlement_id`, `entry_kind`, `delta_half_hours`, `source_key`,
	`leave_request_id`, `note`, `created_by`, `created_at`
)
SELECT
	`id`, `entitlement_id`, `entry_kind`, `delta_half_hours`, `source_key`,
	`leave_request_id`, `note`, `created_by`, `created_at`
FROM `__repair_hr_annual_leave_ledger`;--> statement-breakpoint
DROP TABLE `__repair_hr_annual_leave_ledger`;--> statement-breakpoint
DROP TABLE `__repair_hr_leave_requests`;--> statement-breakpoint
UPDATE `hr_leave_requests`
SET `leave_type_id` = (
	SELECT `id`
	FROM `hr_leave_types`
	WHERE replace(replace(trim(`name`), ' ', ''), '　', '') = replace(replace(trim(`hr_leave_requests`.`leave_type`), ' ', ''), '　', '')
	ORDER BY `active` DESC, `id`
	LIMIT 1
)
WHERE `leave_type_id` IS NULL;--> statement-breakpoint
UPDATE `hr_leave_requests`
SET `starts_at` = datetime(`starts_on` || ' 00:00:00', '-8 hours'),
	`ends_at` = datetime(`ends_on` || ' 00:00:00', '-8 hours')
WHERE `starts_at` = '' OR `ends_at` = '';--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_period` ON `hr_leave_requests` (`employment_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_time` ON `hr_leave_requests` (`employment_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_leave_type` ON `hr_leave_requests` (`leave_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_annual_leave_ledger_source` ON `hr_annual_leave_ledger` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_hr_annual_leave_ledger_entitlement` ON `hr_annual_leave_ledger` (`entitlement_id`,`created_at`);
