-- Drop the retired source_period_key columns. Existing adjustment and record-item
-- rows are preserved, but their obsolete relational source-month values are removed.
-- Mutable payroll snapshots are normalized below; closed snapshots remain immutable.
-- Rebuild the affected tables without disabling foreign-key enforcement, then restore
-- the closed-period protection triggers.
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_amount_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_amount_update`;--> statement-breakpoint
ALTER TABLE `hr_payroll_adjustments` RENAME TO `__hr_payroll_adjustments_0201_old`;--> statement-breakpoint
CREATE TABLE `hr_payroll_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`effective_period_key` text NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_adjustments_effective_period" CHECK("hr_payroll_adjustments"."effective_period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_hr_payroll_adjustments_reason" CHECK(length(trim("hr_payroll_adjustments"."reason")) BETWEEN 1 AND 1000),
	CONSTRAINT "ck_hr_payroll_adjustments_revision" CHECK("hr_payroll_adjustments"."revision" > 0)
);--> statement-breakpoint
INSERT INTO `hr_payroll_adjustments`("id", "employment_id", "effective_period_key", "reason", "created_by", "created_at", "updated_by", "updated_at", "revision") SELECT "id", "employment_id", "effective_period_key", "reason", "created_by", "created_at", "updated_by", "updated_at", "revision" FROM `__hr_payroll_adjustments_0201_old`;--> statement-breakpoint
CREATE TABLE `__new_hr_payroll_adjustment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`adjustment_id` text NOT NULL,
	`item_name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`adjustment_id`) REFERENCES `hr_payroll_adjustments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_adjustment_items_name" CHECK(length(trim("__new_hr_payroll_adjustment_items"."item_name")) BETWEEN 1 AND 100)
);--> statement-breakpoint
INSERT INTO `__new_hr_payroll_adjustment_items`("id", "adjustment_id", "item_name", "amount_minor", "created_at") SELECT "id", "adjustment_id", "item_name", "amount_minor", "created_at" FROM `hr_payroll_adjustment_items`;--> statement-breakpoint
CREATE TABLE `__new_hr_payroll_record_items` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`person_kind` text NOT NULL,
	`employment_id` text,
	`worker_id` text,
	`item_name` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_record_items_person" CHECK(("__new_hr_payroll_record_items"."person_kind" = 'employee' AND "__new_hr_payroll_record_items"."employment_id" IS NOT NULL AND "__new_hr_payroll_record_items"."worker_id" IS NULL) OR ("__new_hr_payroll_record_items"."person_kind" = 'worker' AND "__new_hr_payroll_record_items"."employment_id" IS NULL AND "__new_hr_payroll_record_items"."worker_id" IS NOT NULL)),
	CONSTRAINT "ck_hr_payroll_record_items_name" CHECK(length(trim("__new_hr_payroll_record_items"."item_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_payroll_record_items_direction" CHECK("__new_hr_payroll_record_items"."direction" IN ('earning', 'deduction')),
	CONSTRAINT "ck_hr_payroll_record_items_amount" CHECK("__new_hr_payroll_record_items"."amount_minor" > 0),
	CONSTRAINT "ck_hr_payroll_record_items_reason" CHECK(length(trim("__new_hr_payroll_record_items"."reason")) BETWEEN 1 AND 1000)
);--> statement-breakpoint
INSERT INTO `__new_hr_payroll_record_items`("id", "payroll_run_id", "person_kind", "employment_id", "worker_id", "item_name", "direction", "amount_minor", "reason", "created_by", "created_at") SELECT "id", "payroll_run_id", "person_kind", "employment_id", "worker_id", "item_name", "direction", "amount_minor", "reason", "created_by", "created_at" FROM `hr_payroll_record_items`;--> statement-breakpoint
DROP TABLE `hr_payroll_adjustment_items`;--> statement-breakpoint
DROP TABLE `hr_payroll_record_items`;--> statement-breakpoint
DROP TABLE `__hr_payroll_adjustments_0201_old`;--> statement-breakpoint
ALTER TABLE `__new_hr_payroll_adjustment_items` RENAME TO `hr_payroll_adjustment_items`;--> statement-breakpoint
ALTER TABLE `__new_hr_payroll_record_items` RENAME TO `hr_payroll_record_items`;--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustments_effective` ON `hr_payroll_adjustments` (`effective_period_key`,`employment_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_adjustment_items_adjustment` ON `hr_payroll_adjustment_items` (`adjustment_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_record_items_record` ON `hr_payroll_record_items` (`payroll_run_id`,`person_kind`,`employment_id`,`worker_id`);--> statement-breakpoint
-- Ready/calculating runs must keep comparing equal after the adjustment row loses
-- sourcePeriodKey. Closed payroll snapshots remain immutable historical records.
UPDATE `hr_payroll_runs`
SET `source_snapshot_json` = json_set(
  `source_snapshot_json`,
  '$.adjustments',
  json((SELECT json_group_array(json_remove(adjustment.value, '$.sourcePeriodKey'))
    FROM json_each(`source_snapshot_json`, '$.adjustments') AS adjustment))
)
WHERE `status` <> 'closed'
  AND json_valid(`source_snapshot_json`)
  AND json_type(`source_snapshot_json`, '$.adjustments') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(`source_snapshot_json`, '$.adjustments') AS adjustment
    WHERE json_type(adjustment.value, '$.sourcePeriodKey') IS NOT NULL
  );--> statement-breakpoint
UPDATE `hr_payslip_lines`
SET `explanation_json` = CASE
  WHEN json_type(`explanation_json`, '$.formulaDetail') = 'text' THEN json_set(
    json_remove(`explanation_json`, '$.sourcePeriodKey'),
    '$.formulaDetail',
    replace(
      json_extract(`explanation_json`, '$.formulaDetail'),
      '人工調整（來源 ' || json_extract(`explanation_json`, '$.sourcePeriodKey') || '）',
      '人工加扣項（' || coalesce(json_extract(`explanation_json`, '$.itemName'), '薪資加扣項') || '）'
    )
  )
  ELSE json_remove(`explanation_json`, '$.sourcePeriodKey')
END
WHERE json_valid(`explanation_json`)
  AND json_type(`explanation_json`, '$.sourcePeriodKey') IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `hr_payslips` AS `payslip`
    INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id`
    WHERE `payslip`.`id` = `hr_payslip_lines`.`payslip_id` AND `run`.`status` <> 'closed'
  );--> statement-breakpoint
-- Legacy zero-value rows are preserved; new zero-value items are rejected.
CREATE TRIGGER `trg_hr_payroll_adjustment_item_amount_insert`
BEFORE INSERT ON `hr_payroll_adjustment_items`
WHEN NEW.`amount_minor` = 0
BEGIN
  SELECT RAISE(ABORT, 'payroll_adjustment_amount_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_amount_update`
BEFORE UPDATE ON `hr_payroll_adjustment_items`
WHEN NEW.`amount_minor` = 0
BEGIN
  SELECT RAISE(ABORT, 'payroll_adjustment_amount_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_closed_insert`
BEFORE INSERT ON `hr_payroll_adjustments`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `period_key` = NEW.`effective_period_key` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_closed_update`
BEFORE UPDATE ON `hr_payroll_adjustments`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `period_key` IN (OLD.`effective_period_key`, NEW.`effective_period_key`) AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_closed_delete`
BEFORE DELETE ON `hr_payroll_adjustments`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `period_key` = OLD.`effective_period_key` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_closed_insert`
BEFORE INSERT ON `hr_payroll_adjustment_items`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_adjustments` AS `adjustment` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`period_key` = `adjustment`.`effective_period_key` WHERE `adjustment`.`id` = NEW.`adjustment_id` AND `period`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_closed_update`
BEFORE UPDATE ON `hr_payroll_adjustment_items`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_adjustments` AS `adjustment` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`period_key` = `adjustment`.`effective_period_key` WHERE `adjustment`.`id` IN (OLD.`adjustment_id`, NEW.`adjustment_id`) AND `period`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_closed_delete`
BEFORE DELETE ON `hr_payroll_adjustment_items`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_adjustments` AS `adjustment` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`period_key` = `adjustment`.`effective_period_key` WHERE `adjustment`.`id` = OLD.`adjustment_id` AND `period`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
