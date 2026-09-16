-- 0155 只加了欄位、預設 monthly；既有資料必須回填成「原本實際在用的算法」，否則舊的日薪／時薪敘薪
-- 會在這次改動後被重新解讀成月給，金額直接變掉。舊的試算是照版本的計薪方式套用每一筆項目，
-- 所以回填成該版本的 pay_basis，數字與改動前一致。
UPDATE hr_compensation_items
SET amount_basis = coalesce(
  (SELECT pay_basis FROM hr_compensation_versions WHERE id = hr_compensation_items.compensation_version_id),
  'monthly'
);
