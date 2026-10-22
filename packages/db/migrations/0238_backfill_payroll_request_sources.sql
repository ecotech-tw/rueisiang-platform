INSERT INTO hr_payroll_request_source_runs (payroll_run_id)
SELECT id FROM hr_payroll_runs;

INSERT INTO hr_payroll_request_sources (id, payroll_run_id, source_kind, source_id)
SELECT lower(hex(randomblob(16))), run.id, 'leave', json_extract(source.value, '$.id')
FROM hr_payroll_runs AS run
JOIN json_each(run.source_snapshot_json, '$.leaves') AS source
WHERE json_type(source.value) = 'object' AND json_type(source.value, '$.id') = 'text';

INSERT INTO hr_payroll_request_sources (id, payroll_run_id, source_kind, source_id)
SELECT lower(hex(randomblob(16))), run.id, 'overtime', json_extract(source.value, '$.id')
FROM hr_payroll_runs AS run
JOIN json_each(run.source_snapshot_json, '$.overtime') AS source
WHERE json_type(source.value) = 'object' AND json_type(source.value, '$.id') = 'text';

INSERT INTO hr_payroll_request_sources (id, payroll_run_id, source_kind, source_id)
SELECT lower(hex(randomblob(16))), run.id, 'worker_overtime', json_extract(source.value, '$.id')
FROM hr_payroll_runs AS run
JOIN json_each(run.source_snapshot_json, '$.workerOvertime') AS source
WHERE json_type(source.value) = 'object' AND json_type(source.value, '$.id') = 'text';

INSERT INTO hr_payroll_request_sources (id, payroll_run_id, source_kind, source_id)
SELECT lower(hex(randomblob(16))), run.id, 'clock_correction', json_extract(clock.value, '$.correctionRequestId')
FROM hr_payroll_runs AS run
JOIN json_each(run.source_snapshot_json, '$.clocks') AS clock
WHERE json_type(clock.value) = 'object' AND json_type(clock.value, '$.correctionRequestId') = 'text';
