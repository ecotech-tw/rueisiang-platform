-- 撤回後允許管理者刪除整批試算；marker 仍禁止一般直接刪除，只接受刪除流程寫入的交易內 guard。
DROP TRIGGER IF EXISTS `trg_hr_payroll_withdrawal_immutable_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_withdrawal_immutable_delete`
BEFORE DELETE ON `hr_payroll_withdrawals`
WHEN NOT EXISTS (
  SELECT 1
  FROM `hr_mutation_guards`
  WHERE `id` = 'payroll-withdrawal-delete:' || OLD.`payroll_run_id`
    AND `ok` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_withdrawal_immutable');
END;
