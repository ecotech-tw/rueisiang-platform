-- 既有 HR 任職列沒有正式姓名欄位；先沿用帳號目前的自訂名稱，再退回 Google 名稱與信箱，讓升級後每位員工都有可編輯的基準值。
UPDATE hr_employments
SET legal_name = COALESCE(
  NULLIF(trim((SELECT display_name FROM users WHERE users.id = hr_employments.employee_user_id)), ''),
  NULLIF(trim((SELECT google_name FROM users WHERE users.id = hr_employments.employee_user_id)), ''),
  NULLIF(trim((SELECT email FROM users WHERE users.id = hr_employments.employee_user_id)), ''),
  employee_user_id
)
WHERE legal_name = '';
