DELETE FROM hr_shift_versions
WHERE day_type IN ('weekend', 'holiday')
  AND id NOT IN (SELECT shift_version_id FROM hr_schedule_entries)
  AND id NOT IN (SELECT shift_version_id FROM hr_schedule_worker_entries);
