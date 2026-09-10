-- 舊任職沒有出勤設定表；第一筆歷史辦公位置作為主要位置，避免部署後現有員工失去主要地點。
INSERT OR IGNORE INTO hr_employment_attendance_settings (employment_id, attendance_mode, primary_assignment_id)
SELECT employment.id, 'general', (
  SELECT assignment.id FROM hr_employee_attendance_locations AS assignment
  WHERE assignment.employment_id = employment.id
  ORDER BY assignment.valid_from, assignment.id
  LIMIT 1
)
FROM hr_employments AS employment;
