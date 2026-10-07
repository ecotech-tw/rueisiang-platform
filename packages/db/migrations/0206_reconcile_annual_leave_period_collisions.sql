-- 0204 放寬週期唯一鍵後，清理沒有下游歷史的舊版服務日起算額度。
-- 有非 grant 台帳的資料必須留作稽核；它們由服務層排除，之後可與校正後的同日額度並存。
WITH RECURSIVE
monthly_starts AS (
  SELECT employment_id, min(valid_from) AS monthly_start_on
  FROM hr_compensation_versions
  WHERE pay_basis = 'monthly' AND voided_at IS NULL
  GROUP BY employment_id
),
employment_starts AS (
  SELECT
    employment.id AS employment_id,
    CASE
      WHEN monthly.monthly_start_on > coalesce(service.service_start_on, substr(employment.created_at, 1, 10))
        THEN monthly.monthly_start_on
      ELSE coalesce(service.service_start_on, substr(employment.created_at, 1, 10))
    END AS annual_leave_start_on
  FROM hr_employments AS employment
  INNER JOIN monthly_starts AS monthly ON monthly.employment_id = employment.id
  LEFT JOIN hr_employment_service_periods AS service ON service.employment_id = employment.id
),
bounds AS (
  SELECT employment_id, max(period_start) AS max_period_start
  FROM hr_annual_leave_entitlements
  GROUP BY employment_id
),
periods (employment_id, annual_leave_start_on, max_period_start, service_months, period_start, period_end) AS (
  SELECT
    starts.employment_id,
    starts.annual_leave_start_on,
    bounds.max_period_start,
    6,
    date(
      date(starts.annual_leave_start_on, 'start of month', '+6 months'),
      printf('+%d days', min(
        CAST(strftime('%d', starts.annual_leave_start_on) AS INTEGER),
        CAST(strftime('%d', date(starts.annual_leave_start_on, 'start of month', '+7 months', '-1 day')) AS INTEGER)
      ) - 1)
    ),
    date(
      date(starts.annual_leave_start_on, 'start of month', '+12 months'),
      printf('+%d days', min(
        CAST(strftime('%d', starts.annual_leave_start_on) AS INTEGER),
        CAST(strftime('%d', date(starts.annual_leave_start_on, 'start of month', '+13 months', '-1 day')) AS INTEGER)
      ) - 1)
    )
  FROM employment_starts AS starts
  INNER JOIN bounds ON bounds.employment_id = starts.employment_id
  UNION ALL
  SELECT
    period.employment_id,
    period.annual_leave_start_on,
    period.max_period_start,
    CASE WHEN period.service_months = 6 THEN 12 ELSE period.service_months + 12 END,
    period.period_end,
    date(
      date(
        period.annual_leave_start_on,
        'start of month',
        '+' || (CASE WHEN period.service_months = 6 THEN 24 ELSE period.service_months + 24 END) || ' months'
      ),
      printf('+%d days', min(
        CAST(strftime('%d', period.annual_leave_start_on) AS INTEGER),
        CAST(strftime('%d', date(
          period.annual_leave_start_on,
          'start of month',
          '+' || (CASE WHEN period.service_months = 6 THEN 25 ELSE period.service_months + 25 END) || ' months',
          '-1 day'
        )) AS INTEGER)
      ) - 1)
    )
  FROM periods AS period
  WHERE period.period_start <= period.max_period_start
),
invalid_entitlements AS (
  SELECT entitlement.id
  FROM hr_annual_leave_entitlements AS entitlement
  WHERE NOT EXISTS (
    SELECT 1
    FROM periods AS period
    WHERE period.employment_id = entitlement.employment_id
      AND period.service_months = entitlement.service_months
      AND period.period_start = entitlement.period_start
      AND period.period_end = entitlement.period_end
  )
)
DELETE FROM hr_annual_leave_ledger
WHERE entitlement_id IN (SELECT id FROM invalid_entitlements)
  AND NOT EXISTS (
    SELECT 1
    FROM hr_annual_leave_ledger AS history
    WHERE history.entitlement_id = hr_annual_leave_ledger.entitlement_id
      AND history.entry_kind <> 'grant'
  );
--> statement-breakpoint
WITH RECURSIVE
monthly_starts AS (
  SELECT employment_id, min(valid_from) AS monthly_start_on
  FROM hr_compensation_versions
  WHERE pay_basis = 'monthly' AND voided_at IS NULL
  GROUP BY employment_id
),
employment_starts AS (
  SELECT
    employment.id AS employment_id,
    CASE
      WHEN monthly.monthly_start_on > coalesce(service.service_start_on, substr(employment.created_at, 1, 10))
        THEN monthly.monthly_start_on
      ELSE coalesce(service.service_start_on, substr(employment.created_at, 1, 10))
    END AS annual_leave_start_on
  FROM hr_employments AS employment
  INNER JOIN monthly_starts AS monthly ON monthly.employment_id = employment.id
  LEFT JOIN hr_employment_service_periods AS service ON service.employment_id = employment.id
),
bounds AS (
  SELECT employment_id, max(period_start) AS max_period_start
  FROM hr_annual_leave_entitlements
  GROUP BY employment_id
),
periods (employment_id, annual_leave_start_on, max_period_start, service_months, period_start, period_end) AS (
  SELECT
    starts.employment_id,
    starts.annual_leave_start_on,
    bounds.max_period_start,
    6,
    date(
      date(starts.annual_leave_start_on, 'start of month', '+6 months'),
      printf('+%d days', min(
        CAST(strftime('%d', starts.annual_leave_start_on) AS INTEGER),
        CAST(strftime('%d', date(starts.annual_leave_start_on, 'start of month', '+7 months', '-1 day')) AS INTEGER)
      ) - 1)
    ),
    date(
      date(starts.annual_leave_start_on, 'start of month', '+12 months'),
      printf('+%d days', min(
        CAST(strftime('%d', starts.annual_leave_start_on) AS INTEGER),
        CAST(strftime('%d', date(starts.annual_leave_start_on, 'start of month', '+13 months', '-1 day')) AS INTEGER)
      ) - 1)
    )
  FROM employment_starts AS starts
  INNER JOIN bounds ON bounds.employment_id = starts.employment_id
  UNION ALL
  SELECT
    period.employment_id,
    period.annual_leave_start_on,
    period.max_period_start,
    CASE WHEN period.service_months = 6 THEN 12 ELSE period.service_months + 12 END,
    period.period_end,
    date(
      date(
        period.annual_leave_start_on,
        'start of month',
        '+' || (CASE WHEN period.service_months = 6 THEN 24 ELSE period.service_months + 24 END) || ' months'
      ),
      printf('+%d days', min(
        CAST(strftime('%d', period.annual_leave_start_on) AS INTEGER),
        CAST(strftime('%d', date(
          period.annual_leave_start_on,
          'start of month',
          '+' || (CASE WHEN period.service_months = 6 THEN 25 ELSE period.service_months + 25 END) || ' months',
          '-1 day'
        )) AS INTEGER)
      ) - 1)
    )
  FROM periods AS period
  WHERE period.period_start <= period.max_period_start
),
invalid_entitlements AS (
  SELECT entitlement.id
  FROM hr_annual_leave_entitlements AS entitlement
  WHERE NOT EXISTS (
    SELECT 1
    FROM periods AS period
    WHERE period.employment_id = entitlement.employment_id
      AND period.service_months = entitlement.service_months
      AND period.period_start = entitlement.period_start
      AND period.period_end = entitlement.period_end
  )
)
DELETE FROM hr_annual_leave_entitlements AS entitlement
WHERE entitlement.id IN (SELECT id FROM invalid_entitlements)
  AND NOT EXISTS (
    SELECT 1
    FROM hr_annual_leave_ledger AS ledger
    WHERE ledger.entitlement_id = entitlement.id
  );
