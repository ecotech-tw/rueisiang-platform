-- 撤回不是另一種結算狀態：批次回到 ready、清除 claim，撤回原因只作為 append-only 稽核紀錄。
-- 這些 trigger 無法由 drizzle schema 表達，需和資料回填一起安裝。
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_closed_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_closed_update`
BEFORE UPDATE ON `hr_payroll_runs`
WHEN OLD.`status` = 'closed'
  AND NOT (
    NEW.`status` = 'ready'
    AND EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = OLD.`id`)
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_closed_employee_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_employee_delete`
BEFORE DELETE ON `hr_payroll_closed_employees`
WHEN NOT EXISTS (
  SELECT 1
  FROM `hr_payroll_withdrawals` AS `withdrawal`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
  WHERE `withdrawal`.`payroll_run_id` = OLD.`payroll_run_id`
    AND `run`.`status` = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_period_close_requires_claims`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_period_close_requires_claims`
BEFORE UPDATE OF `status` ON `hr_payroll_periods`
WHEN OLD.`status` = 'open' AND NEW.`status` = 'closed'
  AND EXISTS (
    SELECT 1 FROM `hr_employments` AS `employment`
    INNER JOIN `users` AS `account` ON `account`.`id` = `employment`.`employee_user_id`
    WHERE `account`.`status` IN ('active', 'invited')
      AND `employment`.`archived_at` IS NULL
      AND coalesce((SELECT `service_start_on` FROM `hr_employment_service_periods` WHERE `employment_id` = `employment`.`id`), '0001-01-01') < date(NEW.`period_key` || '-01', '+1 month')
      AND NOT EXISTS (
        SELECT 1 FROM `hr_payroll_closed_employees` AS `claim`
        WHERE `claim`.`period_key` = NEW.`period_key`
          AND `claim`.`employment_id` = `employment`.`id`
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_not_ready');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_period_closed_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_period_closed_update`
BEFORE UPDATE ON `hr_payroll_periods`
WHEN OLD.`status` = 'closed'
  AND (
    NEW.`status` <> 'open'
    OR NOT EXISTS (
      SELECT 1
      FROM `hr_payroll_withdrawals` AS `withdrawal`
      INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
      WHERE `run`.`payroll_period_id` = OLD.`id`
        AND `run`.`status` = 'ready'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_insert`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_insert`
BEFORE INSERT ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = NEW.`employment_id` AND `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_update`
BEFORE UPDATE ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` IN (OLD.`employment_id`, NEW.`employment_id`) AND `period`.`period_key` IN (substr(OLD.`leave_date`, 1, 7), substr(NEW.`leave_date`, 1, 7)) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_delete`
BEFORE DELETE ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = OLD.`employment_id` AND `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_insert`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_insert`
BEFORE INSERT ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = NEW.`employment_id` AND `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_update`
BEFORE UPDATE ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` IN (OLD.`employment_id`, NEW.`employment_id`) AND `period`.`period_key` IN (substr(OLD.`work_date`, 1, 7), substr(NEW.`work_date`, 1, 7)) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_delete`
BEFORE DELETE ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = OLD.`employment_id` AND `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
-- 既有 withdrawal marker 可能已保留薪資快照，但升級前的撤回流程未必已完成特休反向台帳；
-- 依薪資單保存的 settlementItems 補寫同一組冪等 reversal source key，原 settlement 永不覆寫。
INSERT OR IGNORE INTO `hr_annual_leave_ledger` (
  `id`, `entitlement_id`, `entry_kind`, `delta_half_hours`, `source_key`,
  `leave_request_id`, `note`, `created_by`
)
SELECT
  'annual-settlement-reversal:' || withdrawal.`payroll_run_id` || ':' || settlement.`source_key`,
  settlement.`entitlement_id`,
  'settlement_reversal',
  -settlement.`delta_half_hours`,
  'annual-settlement-reversal:' || withdrawal.`payroll_run_id` || ':' || settlement.`source_key`,
  NULL,
  '薪資批次撤回（' || withdrawal.`payroll_run_id` || '）恢復未休特休折現額度',
  withdrawal.`withdrawn_by`
FROM `hr_payroll_withdrawals` AS withdrawal
INNER JOIN `hr_payslips` AS payslip ON payslip.`payroll_run_id` = withdrawal.`payroll_run_id`
INNER JOIN `hr_payslip_lines` AS line ON line.`payslip_id` = payslip.`id` AND line.`line_key` = 'annual_leave_settlement'
CROSS JOIN json_each(CASE WHEN json_valid(line.`explanation_json`) THEN line.`explanation_json` ELSE '{}' END, '$.settlementItems') AS item
INNER JOIN `hr_annual_leave_ledger` AS settlement
  ON settlement.`source_key` = json_extract(item.`value`, '$.sourceKey')
  AND settlement.`entry_kind` = 'settlement'
INNER JOIN `hr_annual_leave_entitlements` AS entitlement ON entitlement.`id` = settlement.`entitlement_id`
WHERE entitlement.`status` = 'settled'
  AND entitlement.`settled_at` IS NOT NULL;--> statement-breakpoint
UPDATE `hr_annual_leave_entitlements` AS entitlement
SET `status` = 'open', `settled_at` = NULL
WHERE entitlement.`status` = 'settled'
  AND entitlement.`settled_at` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `hr_payroll_withdrawals` AS withdrawal
    INNER JOIN `hr_payslips` AS payslip ON payslip.`payroll_run_id` = withdrawal.`payroll_run_id`
    INNER JOIN `hr_payslip_lines` AS line ON line.`payslip_id` = payslip.`id` AND line.`line_key` = 'annual_leave_settlement'
    CROSS JOIN json_each(CASE WHEN json_valid(line.`explanation_json`) THEN line.`explanation_json` ELSE '{}' END, '$.settlementItems') AS item
    INNER JOIN `hr_annual_leave_ledger` AS settlement
      ON settlement.`source_key` = json_extract(item.`value`, '$.sourceKey')
      AND settlement.`entry_kind` = 'settlement'
    INNER JOIN `hr_annual_leave_ledger` AS reversal
      ON reversal.`source_key` = 'annual-settlement-reversal:' || withdrawal.`payroll_run_id` || ':' || settlement.`source_key`
      AND reversal.`entry_kind` = 'settlement_reversal'
    WHERE settlement.`entitlement_id` = entitlement.`id`
  );--> statement-breakpoint
-- 舊版已寫入 withdrawal marker 但仍停在 closed 的資料，升級時一併退回未結算。
UPDATE `hr_payroll_runs`
SET `status` = 'ready', `approved_by` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `status` = 'closed'
  AND EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `hr_payroll_runs`.`id`);--> statement-breakpoint
UPDATE `hr_payroll_periods`
SET `status` = 'open', `revision` = `revision` + 1, `updated_at` = CURRENT_TIMESTAMP
WHERE `status` = 'closed'
  AND EXISTS (
    SELECT 1
    FROM `hr_payroll_withdrawals` AS `withdrawal`
    INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
    WHERE `run`.`payroll_period_id` = `hr_payroll_periods`.`id`
      AND `run`.`status` = 'ready'
  );--> statement-breakpoint
DELETE FROM `hr_payroll_closed_employees`
WHERE EXISTS (
  SELECT 1
  FROM `hr_payroll_withdrawals` AS `withdrawal`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
  WHERE `withdrawal`.`payroll_run_id` = `hr_payroll_closed_employees`.`payroll_run_id`
    AND `run`.`status` = 'ready'
);--> statement-breakpoint
DELETE FROM `hr_payroll_closed_workers`
WHERE EXISTS (
  SELECT 1
  FROM `hr_payroll_withdrawals` AS `withdrawal`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
  WHERE `withdrawal`.`payroll_run_id` = `hr_payroll_closed_workers`.`payroll_run_id`
    AND `run`.`status` = 'ready'
);
