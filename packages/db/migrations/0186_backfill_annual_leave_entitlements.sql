-- 既有員工的週年制特休回填。額度與 grant ledger 使用穩定 ID／source key，重跑不重複。
-- 日期計算刻意以目標月份最後一天夾住日數，讓 2 月 29 日與服務層規則一致。
WITH RECURSIVE milestones (employment_id, service_start_on, archived_at, service_months, period_start, period_end) AS (
  SELECT
    e.id,
    service.service_start_on,
    e.archived_at,
    6,
    date(
      date(service.service_start_on, 'start of month', '+6 months'),
      printf('+%d days', min(
        CAST(strftime('%d', service.service_start_on) AS INTEGER),
        CAST(strftime('%d', date(service.service_start_on, 'start of month', '+7 months', '-1 day')) AS INTEGER)
      ) - 1)
    ),
    date(
      date(service.service_start_on, 'start of month', '+12 months'),
      printf('+%d days', min(
        CAST(strftime('%d', service.service_start_on) AS INTEGER),
        CAST(strftime('%d', date(service.service_start_on, 'start of month', '+13 months', '-1 day')) AS INTEGER)
      ) - 1)
    )
  FROM hr_employments AS e
  INNER JOIN hr_employment_service_periods AS service ON service.employment_id = e.id
  WHERE service.service_start_on <= date('now')
  UNION ALL
  SELECT
    m.employment_id,
    m.service_start_on,
    m.archived_at,
    CASE WHEN m.service_months = 6 THEN 12 ELSE m.service_months + 12 END,
    m.period_end,
    date(
      date(
        m.service_start_on,
        'start of month',
        '+' || (CASE WHEN m.service_months = 6 THEN 24 ELSE m.service_months + 24 END) || ' months'
      ),
      printf('+%d days', min(
        CAST(strftime('%d', m.service_start_on) AS INTEGER),
        CAST(strftime('%d', date(
          m.service_start_on,
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
  AND (m.archived_at IS NULL OR m.period_start < substr(m.archived_at, 1, 10));
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
-- 舊申請只有 leave_type snapshot；名稱可能保留了全形／半形空白，先用同一套規則找回特休主檔。
UPDATE hr_leave_requests
SET leave_type_id = (
  SELECT t.id FROM hr_leave_types AS t
  WHERE t.leave_kind = 'annual'
    AND replace(replace(trim(t.name), ' ', ''), '　', '') = replace(replace(trim(hr_leave_requests.leave_type), ' ', ''), '　', '')
  LIMIT 1
)
WHERE leave_type_id IS NULL
  AND EXISTS (
    SELECT 1 FROM hr_leave_types AS t
    WHERE t.leave_kind = 'annual'
      AND replace(replace(trim(t.name), ' ', ''), '　', '') = replace(replace(trim(hr_leave_requests.leave_type), ' ', ''), '　', '')
  );
--> statement-breakpoint
-- 同一期別的多筆歷史申請必須以同一個穩定順序累計檢查；只用單筆目前餘額會讓同批申請各自通過，最後留下負餘額。
WITH eligible_annual_leave_usage AS (
  SELECT
    r.id AS request_id,
    r.starts_on,
    r.ends_on,
    r.created_by,
    e.id AS entitlement_id,
    r.duration_minutes / 30 AS required_half_hours,
    coalesce((
      SELECT sum(l.delta_half_hours) FROM hr_annual_leave_ledger AS l
      WHERE l.entitlement_id = e.id
    ), 0) AS balance_half_hours
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
    )
), usage_with_running_total AS (
  SELECT
    usage.*,
    coalesce(sum(usage.required_half_hours) OVER (
      PARTITION BY usage.entitlement_id
      ORDER BY usage.starts_on, usage.ends_on, usage.request_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS prior_required_half_hours
  FROM eligible_annual_leave_usage AS usage
)
INSERT OR IGNORE INTO hr_annual_leave_ledger (
  id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by
)
SELECT
  'annual-usage:' || request_id,
  entitlement_id,
  'leave_request',
  -required_half_hours,
  'leave-request:' || request_id,
  request_id,
  '既有核准特休使用回填',
  created_by
FROM usage_with_running_total
WHERE balance_half_hours - prior_required_half_hours >= required_half_hours;
--> statement-breakpoint
-- 無法完整對應單一期別、時數格式不合法或歷史餘額不足的資料不能靜默略過；
-- 留一筆系統稽核，讓 HR 能從操作紀錄找到需要人工調整的申請。
WITH annual_leave_backfill_issues AS (
  SELECT
    r.id,
    r.leave_type,
    r.starts_on,
    r.ends_on,
    r.duration_minutes,
    CASE
      WHEN r.duration_minutes < 30 OR r.duration_minutes % 30 <> 0 THEN 'invalid_duration'
      WHEN NOT EXISTS (
        SELECT 1 FROM hr_annual_leave_entitlements AS e
        WHERE e.employment_id = r.employment_id
          AND r.starts_on >= e.period_start
          AND r.ends_on <= e.period_end
      ) THEN 'cross_period_or_missing_entitlement'
      WHEN coalesce((
        SELECT sum(l.delta_half_hours)
        FROM hr_annual_leave_ledger AS l
        INNER JOIN hr_annual_leave_entitlements AS e ON e.id = l.entitlement_id
        WHERE e.employment_id = r.employment_id
          AND r.starts_on >= e.period_start
          AND r.ends_on <= e.period_end
      ), 0) < (r.duration_minutes / 30) THEN 'insufficient_balance'
      ELSE 'unmatched_annual_leave'
    END AS issue_kind
  FROM hr_leave_requests AS r
  LEFT JOIN hr_leave_types AS t ON t.id = r.leave_type_id
  WHERE r.status = 'approved'
    AND (t.leave_kind = 'annual' OR replace(replace(trim(r.leave_type), ' ', ''), '　', '') IN ('特休', '特別休假'))
    AND NOT EXISTS (
      SELECT 1 FROM hr_annual_leave_ledger AS l
      WHERE l.source_key = 'leave-request:' || r.id
    )
)
INSERT OR IGNORE INTO activity_events (
  id, entity_type, entity_id, entity_label, event_type, summary, field,
  payload_json, actor_type, source, status, error
)
SELECT
  'annual-leave-backfill-issue:' || id,
  'hr_leave_request',
  id,
  leave_type,
  'annual_leave_backfill_unmatched',
  '既有核准特休使用未能自動回填，需人工核對',
  'annual_leave_backfill',
  json_object('issueKind', issue_kind, 'startsOn', starts_on, 'endsOn', ends_on, 'durationMinutes', duration_minutes),
  'system',
  'hr',
  'failed',
  issue_kind
FROM annual_leave_backfill_issues;
