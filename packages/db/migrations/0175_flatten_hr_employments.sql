-- 人事扁平化的資料搬移。0174 只建立可容納新欄位的過渡結構；這一支才
-- 依既有 hr_employees 回填員工編號與主管，並把每位使用者最新的未結束任職
-- 保留為目前主檔。較舊、已結束或已撤回的列只標成 archived_at，不改 employment id，
-- 因此外鍵指向的出勤、薪資、保險與稽核歷史仍然成立。
UPDATE `hr_employments`
SET
  `employee_number` = COALESCE(
    (SELECT `employee_number` FROM `hr_employees` AS employee WHERE employee.`user_id` = `hr_employments`.`employee_user_id`),
    'LEGACY-' || substr(`hr_employments`.`id`, 1, 32)
  ),
  `supervisor_user_id` = (SELECT `supervisor_user_id` FROM `hr_employees` AS employee WHERE employee.`user_id` = `hr_employments`.`employee_user_id`),
  `archived_at` = CASE
    WHEN `hr_employments`.`revoked_at` IS NOT NULL THEN `hr_employments`.`revoked_at`
    WHEN `hr_employments`.`ended_on` IS NOT NULL THEN `hr_employments`.`ended_on`
    WHEN `hr_employments`.`id` = (
      SELECT current_employment.`id`
      FROM `hr_employments` AS current_employment
      WHERE current_employment.`employee_user_id` = `hr_employments`.`employee_user_id`
        AND current_employment.`revoked_at` IS NULL
        AND current_employment.`ended_on` IS NULL
      ORDER BY current_employment.`hired_on` DESC, current_employment.`created_at` DESC, current_employment.`id` DESC
      LIMIT 1
    ) THEN NULL
    ELSE COALESCE(`hr_employments`.`updated_at`, CURRENT_TIMESTAMP)
  END;
--> statement-breakpoint

-- 舊資料可能只有 employee record 沒有任職列；補一個穩定的 employment id，避免
-- 把仍然存在的員工從 HRIS 靜默移除。日期只供過渡欄位使用，0176 會移除它們。
INSERT INTO `hr_employments` (
  `id`, `employee_user_id`, `hired_on`, `ended_on`, `seniority_start_on`, `revoked_at`, `revoked_by`,
  `employee_number`, `position`, `supervisor_user_id`, `archived_at`, `revision`, `created_at`, `updated_at`
)
SELECT
  'legacy-employment-' || employee.`user_id`,
  employee.`user_id`,
  substr(COALESCE(employee.`created_at`, CURRENT_TIMESTAMP), 1, 10),
  NULL,
  substr(COALESCE(employee.`created_at`, CURRENT_TIMESTAMP), 1, 10),
  NULL,
  NULL,
  employee.`employee_number`,
  '一般職員',
  employee.`supervisor_user_id`,
  NULL,
  employee.`revision`,
  employee.`created_at`,
  employee.`updated_at`
FROM `hr_employees` AS employee
WHERE NOT EXISTS (
  SELECT 1 FROM `hr_employments` AS employment
  WHERE employment.`employee_user_id` = employee.`user_id`
);
