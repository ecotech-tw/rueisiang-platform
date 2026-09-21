-- 初始公司共用特休政策：週年制、未休不自動遞延、半小時為最小儲存單位。
-- 法定級距以資料列保存，後續法規／公司政策變更應新增版本，不覆寫既有版本。
INSERT OR IGNORE INTO hr_annual_leave_policy_versions (
  id, policy_key, version_number, valid_from, valid_to, basis,
  daily_minutes, minimum_unit_minutes, carryover_allowed, note, created_by
) VALUES (
  'annual-leave-policy-2017-v1', 'annual_leave', 1, '2017-01-01', NULL, 'anniversary',
  480, 30, 0,
  '勞動基準法第 38 條週年制初始版本；未休額度不自動遞延，法定級距依版本資料列保存。', NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO hr_annual_leave_brackets
  (id, policy_version_id, min_service_months, max_service_months, entitled_days, label)
VALUES
  ('annual-leave-bracket-6m', 'annual-leave-policy-2017-v1', 6, 12, 3, '滿半年至未滿一年'),
  ('annual-leave-bracket-1y', 'annual-leave-policy-2017-v1', 12, 24, 7, '滿一年至未滿二年'),
  ('annual-leave-bracket-2y', 'annual-leave-policy-2017-v1', 24, 36, 10, '滿二年至未滿三年'),
  ('annual-leave-bracket-3y', 'annual-leave-policy-2017-v1', 36, 48, 14, '滿三年至未滿四年'),
  ('annual-leave-bracket-4y', 'annual-leave-policy-2017-v1', 48, 60, 14, '滿四年至未滿五年'),
  ('annual-leave-bracket-5y', 'annual-leave-policy-2017-v1', 60, 72, 15, '滿五年至未滿六年'),
  ('annual-leave-bracket-6y', 'annual-leave-policy-2017-v1', 72, 84, 15, '滿六年至未滿七年'),
  ('annual-leave-bracket-7y', 'annual-leave-policy-2017-v1', 84, 96, 15, '滿七年至未滿八年'),
  ('annual-leave-bracket-8y', 'annual-leave-policy-2017-v1', 96, 108, 15, '滿八年至未滿九年'),
  ('annual-leave-bracket-9y', 'annual-leave-policy-2017-v1', 108, 120, 15, '滿九年至未滿十年'),
  ('annual-leave-bracket-10y', 'annual-leave-policy-2017-v1', 120, 132, 16, '滿十年至未滿十一年'),
  ('annual-leave-bracket-11y', 'annual-leave-policy-2017-v1', 132, 144, 17, '滿十一年至未滿十二年'),
  ('annual-leave-bracket-12y', 'annual-leave-policy-2017-v1', 144, 156, 18, '滿十二年至未滿十三年'),
  ('annual-leave-bracket-13y', 'annual-leave-policy-2017-v1', 156, 168, 19, '滿十三年至未滿十四年'),
  ('annual-leave-bracket-14y', 'annual-leave-policy-2017-v1', 168, 180, 20, '滿十四年至未滿十五年'),
  ('annual-leave-bracket-15y', 'annual-leave-policy-2017-v1', 180, 192, 21, '滿十五年至未滿十六年'),
  ('annual-leave-bracket-16y', 'annual-leave-policy-2017-v1', 192, 204, 22, '滿十六年至未滿十七年'),
  ('annual-leave-bracket-17y', 'annual-leave-policy-2017-v1', 204, 216, 23, '滿十七年至未滿十八年'),
  ('annual-leave-bracket-18y', 'annual-leave-policy-2017-v1', 216, 228, 24, '滿十八年至未滿十九年'),
  ('annual-leave-bracket-19y', 'annual-leave-policy-2017-v1', 228, 240, 25, '滿十九年至未滿二十年'),
  ('annual-leave-bracket-20y', 'annual-leave-policy-2017-v1', 240, 252, 26, '滿二十年至未滿二十一年'),
  ('annual-leave-bracket-21y', 'annual-leave-policy-2017-v1', 252, 264, 27, '滿二十一年至未滿二十二年'),
  ('annual-leave-bracket-22y', 'annual-leave-policy-2017-v1', 264, 276, 28, '滿二十二年至未滿二十三年'),
  ('annual-leave-bracket-23y', 'annual-leave-policy-2017-v1', 276, 288, 29, '滿二十三年至未滿二十四年'),
  ('annual-leave-bracket-24y-plus', 'annual-leave-policy-2017-v1', 288, NULL, 30, '滿二十四年以上');
