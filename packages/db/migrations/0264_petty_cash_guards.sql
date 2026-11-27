-- 零用金紀錄的守門 trigger（Drizzle 不管 trigger，所以另開這支自訂 migration）。
-- 紀錄只能新增，不改、不刪舊的；「增加」打錯就記一筆更正。
-- 餘額不能變負數：寫入端已經用條件式 INSERT 檢查餘額，這裡是最後一道保險。
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
