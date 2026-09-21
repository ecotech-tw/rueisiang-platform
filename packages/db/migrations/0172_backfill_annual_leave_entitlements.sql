-- 既有員工的週年制特休回填。額度與 grant ledger 使用穩定 ID／source key，重跑不重複。
-- 日期計算刻意以目標月份最後一天夾住日數，讓 2 月 29 日與服務層規則一致。
WITH RECURSIVE milestones (employment_id, seniority_start_on, ended_on, service_months, period_start, period_end) AS (
  SELECT
    e.id,
    e.seniority_start_on,
    e.ended_on,
    6,
    date(
      date(e.seniority_start_on, 'start of month', '+6 months'),
      printf('+%d days', min(
        CAST(strftime('%d', e.seniority_start_on) AS INTEGER),
        CAST(strftime('%d', date(e.seniority_start_on, 'start of month', '+7 months', '-1 day')) AS INTEGER)
      ) - 1)
    ),
    date(
      date(e.seniority_start_on, 'start of month', '+12 months'),
      printf('+%d days', min(
        CAST(strftime('%d', e.seniority_start_on) AS INTEGER),
        CAST(strftime('%d', date(e.seniority_start_on, 'start of month', '+13 months', '-1 day')) AS INTEGER)
      ) - 1)
    )
  FROM hr_employments AS e
  WHERE e.seniority_start_on <= date('now')
  UNION ALL
  SELECT
    m.employment_id,
    m.seniority_start_on,
    m.ended_on,
    CASE WHEN m.service_months = 6 THEN 12 ELSE m.service_months + 12 END,
    m.period_end,
    date(
      date(
        m.seniority_start_on,
        'start of month',
        '+' || (CASE WHEN m.service_months = 6 THEN 24 ELSE m.service_months + 24 END) || ' months'
      ),
      printf('+%d days', min(
        CAST(strftime('%d', m.seniority_start_on) AS INTEGER),
        CAST(strftime('%d', date(
          m.seniority_start_on,
          'start of month',
          '+' || (CASE WHEN m.service_months = 6 THEN 25 ELSE m.service_months + 25 END) || ' months',
          '-1 day'
        )) AS INTEGER)
      ) - 1)
    )
  FROM milestones AS m
  WHERE m.period_start <= date('now')
)
INSERT OR IGNORE INTO hr_annual_leave_entitlements (
  id, employment_id, policy_version_id, bracket_id, service_months,
  period_start, period_end, entitled_half_hours, status, created_by
)
SELECT
  'annual-entitlement:' || m.employment_id || ':' || m.period_start,
  m.employment_id,
  p.id,
  b.id,
  m.service_months,
  m.period_start,
  m.period_end,
  b.entitled_days * p.daily_minutes / p.minimum_unit_minutes,
  'open',
  NULL
FROM milestones AS m
INNER JOIN hr_annual_leave_policy_versions AS p
  ON p.policy_key = 'annual_leave'
  AND p.valid_from <= m.period_start
  AND (p.valid_to IS NULL OR p.valid_to > m.period_start)
INNER JOIN hr_annual_leave_brackets AS b
  ON b.policy_version_id = p.id
  AND b.min_service_months <= m.service_months
  AND (b.max_service_months IS NULL OR b.max_service_months > m.service_months)
WHERE m.period_start <= date('now')
  AND (m.ended_on IS NULL OR m.period_start < m.ended_on);
--> statement-breakpoint
INSERT OR IGNORE INTO hr_annual_leave_ledger (
  id, entitlement_id, entry_kind, delta_half_hours, source_key, note, created_by
)
SELECT
  'annual-grant:' || e.employment_id || ':' || e.period_start,
  e.id,
  'grant',
  e.entitled_half_hours,
  'annual-grant:' || e.employment_id || ':' || e.period_start,
  '既有員工週年制特休回填',
  NULL
FROM hr_annual_leave_entitlements AS e
WHERE NOT EXISTS (
  SELECT 1 FROM hr_annual_leave_ledger AS l
  WHERE l.source_key = 'annual-grant:' || e.employment_id || ':' || e.period_start
);
--> statement-breakpoint
-- 0168 以前沒有 leave_kind；只對既有的明確中文特休名稱做一次相容回填，其他假別不靠名稱猜測。
UPDATE hr_leave_types
SET leave_kind = 'annual'
WHERE leave_kind = 'other'
  AND replace(replace(trim(name), ' ', ''), '　', '') IN ('特休', '特別休假');
--> statement-breakpoint
-- 舊申請只有 leave_type snapshot；若它對應到明確的特休主檔，回填 leave_type_id 與已核准 usage。
UPDATE hr_leave_requests
SET leave_type_id = (
  SELECT t.id FROM hr_leave_types AS t
  WHERE t.leave_kind = 'annual' AND t.name = hr_leave_requests.leave_type
  LIMIT 1
)
WHERE leave_type_id IS NULL
  AND EXISTS (
    SELECT 1 FROM hr_leave_types AS t
    WHERE t.leave_kind = 'annual' AND t.name = hr_leave_requests.leave_type
  );
--> statement-breakpoint
INSERT OR IGNORE INTO hr_annual_leave_ledger (
  id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by
)
SELECT
  'annual-usage:' || r.id,
  e.id,
  'leave_request',
  -(r.duration_minutes / 30),
  'leave-request:' || r.id,
  r.id,
  '既有核准特休使用回填',
  r.created_by
FROM hr_leave_requests AS r
INNER JOIN hr_leave_types AS t ON t.id = r.leave_type_id AND t.leave_kind = 'annual'
INNER JOIN hr_annual_leave_entitlements AS e
  ON e.employment_id = r.employment_id
  AND r.starts_on >= e.period_start
  AND r.ends_on <= e.period_end
WHERE r.status = 'approved'
  AND r.duration_minutes >= 30
  AND r.duration_minutes % 30 = 0
  AND NOT EXISTS (
    SELECT 1 FROM hr_annual_leave_ledger AS l
    WHERE l.source_key = 'leave-request:' || r.id
  );
