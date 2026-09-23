-- 舊請假申請只有日期區間；以台北每日 00:00 到下一日 00:00 回填時間端點，保留歷史資料可讀性。
-- starts_at／ends_at 是 canonical UTC wall-clock，SQLite 的 -8 hours 不依賴部署主機時區。
UPDATE hr_leave_requests
SET
  starts_at = datetime(starts_on || ' 00:00:00', '-8 hours'),
  ends_at = datetime(ends_on || ' 00:00:00', '-8 hours')
WHERE starts_at = '' OR ends_at = '';
