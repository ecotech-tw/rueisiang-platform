-- 回填 0140 新增的打卡歷史快照，避免既有紀錄隨目前辦公位置名稱變動。
UPDATE hr_clock_events
SET scope_id = (
  SELECT scope_id
  FROM hr_attendance_locations
  WHERE hr_attendance_locations.id = hr_clock_events.attendance_location_id
)
WHERE hr_clock_events.scope_id IS NULL
  AND hr_clock_events.attendance_location_id IS NOT NULL;
--> statement-breakpoint
UPDATE hr_clock_events
SET location_name_snapshot = (
  SELECT name
  FROM hr_attendance_locations
  WHERE hr_attendance_locations.id = hr_clock_events.attendance_location_id
)
WHERE hr_clock_events.location_name_snapshot = ''
  AND hr_clock_events.attendance_location_id IS NOT NULL;
--> statement-breakpoint
UPDATE hr_clock_events
SET scope_name_snapshot = coalesce((
  SELECT scopes.name
  FROM scopes
  INNER JOIN hr_attendance_locations ON hr_attendance_locations.scope_id = scopes.id
  WHERE hr_attendance_locations.id = hr_clock_events.attendance_location_id
), '')
WHERE hr_clock_events.scope_name_snapshot = ''
  AND hr_clock_events.attendance_location_id IS NOT NULL;
