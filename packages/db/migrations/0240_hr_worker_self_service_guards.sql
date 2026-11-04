-- 出勤共用原 employmentId；只放寬出勤，不放寬正式員工的假勤、敘薪或保險限制。
DROP TRIGGER `trg_hr_formal_attendance_locations_kind_insert`;
--> statement-breakpoint
DROP TRIGGER `trg_hr_formal_attendance_locations_kind_update`;
--> statement-breakpoint
DROP TRIGGER `trg_hr_formal_attendance_settings_kind_insert`;
--> statement-breakpoint
DROP TRIGGER `trg_hr_formal_attendance_settings_kind_update`;
--> statement-breakpoint
DROP TRIGGER `trg_hr_formal_clock_events_identity_insert`;
--> statement-breakpoint
DROP TRIGGER `trg_hr_formal_clock_events_identity_update`;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_clock_events_identity_insert`
BEFORE INSERT ON `hr_clock_events`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_employments` AS employment WHERE employment.id = NEW.employment_id
    AND ((employment.person_kind = 'employee' AND employment.employee_user_id = NEW.employee_user_id)
      OR (employment.person_kind = 'worker' AND EXISTS (
        SELECT 1 FROM `hr_worker_account_links` AS link WHERE link.worker_id = employment.id AND link.user_id = NEW.employee_user_id
      )))
)
BEGIN
  SELECT RAISE(ABORT, 'hr_clock_identity_mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_clock_events_identity_update`
BEFORE UPDATE OF `employment_id`, `employee_user_id` ON `hr_clock_events`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_employments` AS employment WHERE employment.id = NEW.employment_id
    AND ((employment.person_kind = 'employee' AND employment.employee_user_id = NEW.employee_user_id)
      OR (employment.person_kind = 'worker' AND EXISTS (
        SELECT 1 FROM `hr_worker_account_links` AS link WHERE link.worker_id = employment.id AND link.user_id = NEW.employee_user_id
      )))
)
BEGIN
  SELECT RAISE(ABORT, 'hr_clock_identity_mismatch');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_account_kind_insert`
BEFORE INSERT ON `hr_worker_account_links`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE id = NEW.worker_id AND person_kind = 'worker')
  OR EXISTS (SELECT 1 FROM `hr_employments` WHERE employee_user_id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'worker_account_identity_conflict');
END;
--> statement-breakpoint
-- 帳號與人員的重新配對不能改變既有薪資與出勤的擁有者。
CREATE TRIGGER `trg_hr_worker_account_identity_immutable`
BEFORE UPDATE OF `worker_id`, `user_id` ON `hr_worker_account_links`
WHEN NEW.worker_id <> OLD.worker_id OR NEW.user_id <> OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'worker_account_identity_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_employee_worker_account_insert`
BEFORE INSERT ON `hr_employments`
WHEN NEW.employee_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM `hr_worker_account_links` WHERE user_id = NEW.employee_user_id)
BEGIN
  SELECT RAISE(ABORT, 'worker_account_identity_conflict');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_employee_worker_account_update`
BEFORE UPDATE OF `employee_user_id`, `person_kind` ON `hr_employments`
WHEN (NEW.employee_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM `hr_worker_account_links` WHERE user_id = NEW.employee_user_id))
  OR (NEW.person_kind <> 'worker' AND EXISTS (SELECT 1 FROM `hr_worker_account_links` WHERE worker_id = NEW.id))
BEGIN
  SELECT RAISE(ABORT, 'worker_account_identity_conflict');
END;
