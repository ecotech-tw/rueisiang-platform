UPDATE hr_shift_versions
SET day_type = 'legacy_weekend'
WHERE day_type = 'weekend';

UPDATE hr_shift_versions
SET day_type = 'legacy_holiday'
WHERE day_type = 'holiday';
