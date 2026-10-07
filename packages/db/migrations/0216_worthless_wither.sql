-- 0215 已用新增欄位完成需求人力的 schema 變更；這裡只需要補上 1–100 的值域保護。
-- Drizzle 產生的重建會 DROP `hr_shift_templates`，但正式 D1 會把整支 migration 包在
-- transaction 裡，`PRAGMA foreign_keys=OFF` 不會生效；班別版本與據點指派仍指向這張表，
-- 因此不能用「建新表／搬資料／刪舊表」的方式改這個父表。
CREATE TRIGGER `trg_hr_shift_templates_headcount_insert`
BEFORE INSERT ON `hr_shift_templates`
WHEN NEW.`required_headcount` NOT BETWEEN 1 AND 100
BEGIN
  SELECT RAISE(ABORT, 'hr_shift_templates_headcount_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_templates_headcount_update`
BEFORE UPDATE OF `required_headcount` ON `hr_shift_templates`
WHEN NEW.`required_headcount` NOT BETWEEN 1 AND 100
BEGIN
  SELECT RAISE(ABORT, 'hr_shift_templates_headcount_invalid');
END;
