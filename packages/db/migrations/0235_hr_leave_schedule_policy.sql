ALTER TABLE `hr_leave_types`
  ADD COLUMN `schedule_check_required` integer NOT NULL DEFAULT 1
  CHECK (`schedule_check_required` IN (0, 1));
