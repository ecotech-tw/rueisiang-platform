-- 扁平化前可能只有 employee record、沒有出勤設定列；活動員工必須有一列
-- 才能在出勤範圍管理中設定辦公位置與出勤方式。
INSERT INTO `hr_employment_attendance_settings` (`employment_id`, `attendance_mode`, `monthly_rest_days`)
SELECT employment.`id`, 'general', NULL
FROM `hr_employments` AS employment
WHERE employment.`archived_at` IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `hr_employment_attendance_settings` AS setting
    WHERE setting.`employment_id` = employment.`id`
  );
