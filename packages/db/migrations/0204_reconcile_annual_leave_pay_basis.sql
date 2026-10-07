-- 0186 在 pay_basis 規則加入前，可能為沒有月薪敘薪的員工建立額度。
-- 沒有任何使用／調整／結算紀錄的錯誤額度與 grant 可安全移除；有下游台帳的資料保留，
-- 由服務層的 eligibility 檢查留作稽核歷史，不讓 migration 連帶刪除既有業務紀錄。
DELETE FROM hr_annual_leave_ledger
WHERE entitlement_id IN (
  SELECT entitlement.id
  FROM hr_annual_leave_entitlements AS entitlement
  INNER JOIN hr_employments AS employment ON employment.id = entitlement.employment_id
  WHERE NOT EXISTS (
    SELECT 1 FROM hr_compensation_versions AS compensation
    WHERE compensation.employment_id = employment.id
      AND compensation.pay_basis = 'monthly'
      AND compensation.voided_at IS NULL
  )
)
AND NOT EXISTS (
  SELECT 1 FROM hr_annual_leave_ledger AS history
  WHERE history.entitlement_id = hr_annual_leave_ledger.entitlement_id
    AND history.entry_kind <> 'grant'
);
--> statement-breakpoint
DELETE FROM hr_annual_leave_entitlements AS entitlement
WHERE NOT EXISTS (
  SELECT 1 FROM hr_annual_leave_ledger AS ledger
  WHERE ledger.entitlement_id = entitlement.id
)
AND NOT EXISTS (
  SELECT 1 FROM hr_compensation_versions AS compensation
  WHERE compensation.employment_id = entitlement.employment_id
    AND compensation.pay_basis = 'monthly'
    AND compensation.voided_at IS NULL
);
