-- 把既有薪資批次用過的特殊上班日套用與規則版本補進索引表。沒補的話，舊批次用過的套用與版本會被當成沒有薪資依據而可以刪除。
-- 三句都只補還沒有的列，整支可以重跑：部署空窗（migration 已套用、舊版 Worker 還在跑）時建立的批次不會寫索引，要靠重跑補齊。
-- 來源快照：每筆套用一列，帶試算當下記的規則、版本與日期（舊快照可能沒有後三者）。
-- 先看 json_each 的 type 再取欄位：陣列裡不是物件的元素拿去 json_type 會丟 malformed JSON，整支 migration 就失敗。
INSERT INTO `hr_payroll_special_workday_sources` (`id`, `payroll_run_id`, `assignment_id`, `rule_id`, `rule_version_id`, `work_date`)
SELECT lower(hex(randomblob(16))), source.payroll_run_id, source.assignment_id, source.rule_id, source.rule_version_id, source.work_date
FROM (
  SELECT DISTINCT
    payroll_run.id AS payroll_run_id,
    CASE WHEN special_workday.type = 'object' THEN CASE WHEN json_type(special_workday.value, '$.id') = 'text' THEN json_extract(special_workday.value, '$.id') END END AS assignment_id,
    CASE WHEN special_workday.type = 'object' THEN CASE WHEN json_type(special_workday.value, '$.ruleId') = 'text' THEN json_extract(special_workday.value, '$.ruleId') END END AS rule_id,
    CASE WHEN special_workday.type = 'object' THEN CASE WHEN json_type(special_workday.value, '$.ruleVersionId') = 'text' THEN json_extract(special_workday.value, '$.ruleVersionId') END END AS rule_version_id,
    CASE WHEN special_workday.type = 'object' THEN CASE WHEN json_type(special_workday.value, '$.workDate') = 'text' THEN json_extract(special_workday.value, '$.workDate') END END AS work_date
  FROM `hr_payroll_runs` AS payroll_run
  CROSS JOIN json_each(
    CASE WHEN json_valid(payroll_run.source_snapshot_json) AND json_type(payroll_run.source_snapshot_json, '$.specialWorkdays') = 'array'
      THEN json_extract(payroll_run.source_snapshot_json, '$.specialWorkdays')
      ELSE '[]'
    END
  ) AS special_workday
  WHERE special_workday.type = 'object'
) AS source
WHERE (source.assignment_id IS NOT NULL OR source.rule_version_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payroll_special_workday_sources` AS existing
    WHERE existing.payroll_run_id = source.payroll_run_id
      AND existing.assignment_id IS source.assignment_id AND existing.rule_id IS source.rule_id
      AND existing.rule_version_id IS source.rule_version_id AND existing.work_date IS source.work_date
  );
--> statement-breakpoint
-- 早期批次的來源快照沒有 specialWorkdays，只在薪資明細留下套用 ID。
-- 任何一個批次的快照記過這筆套用（上一句補進來的列），就以快照為準、明細不再另外算一筆：明細的列沒有規則與日期，
-- 判斷時會退回看套用「現在」掛在哪條規則，套用被改走之後會把從沒進過薪資的規則也鎖住。
-- 同一批次重跑時也不重複。
INSERT INTO `hr_payroll_special_workday_sources` (`id`, `payroll_run_id`, `assignment_id`, `rule_id`, `rule_version_id`, `work_date`)
SELECT lower(hex(randomblob(16))), source.payroll_run_id, source.assignment_id, NULL, NULL, NULL
FROM (
  SELECT DISTINCT payslip.payroll_run_id AS payroll_run_id, assignment_reference.value AS assignment_id
  FROM `hr_payslip_lines` AS payslip_line
  INNER JOIN `hr_payslips` AS payslip ON payslip.id = payslip_line.payslip_id
  CROSS JOIN json_each(
    CASE WHEN json_valid(payslip_line.explanation_json) AND json_type(payslip_line.explanation_json, '$.assignmentIds') = 'array'
      THEN json_extract(payslip_line.explanation_json, '$.assignmentIds')
      ELSE '[]'
    END
  ) AS assignment_reference
  WHERE assignment_reference.type = 'text'
) AS source
WHERE NOT EXISTS (
  SELECT 1 FROM `hr_payroll_special_workday_sources` AS existing
  WHERE existing.assignment_id = source.assignment_id
    AND (existing.payroll_run_id = source.payroll_run_id OR existing.rule_id IS NOT NULL OR existing.rule_version_id IS NOT NULL OR existing.work_date IS NOT NULL)
);
--> statement-breakpoint
-- 加班明細另外記了當天套用的規則版本；同一批次已經有這一版的不重複。
INSERT INTO `hr_payroll_special_workday_sources` (`id`, `payroll_run_id`, `assignment_id`, `rule_id`, `rule_version_id`, `work_date`)
SELECT lower(hex(randomblob(16))), source.payroll_run_id, NULL, NULL, source.rule_version_id, source.work_date
FROM (
  SELECT DISTINCT
    payslip.payroll_run_id AS payroll_run_id,
    CASE WHEN rule_snapshot.type = 'object' THEN CASE WHEN json_type(rule_snapshot.value, '$.ruleVersionId') = 'text' THEN json_extract(rule_snapshot.value, '$.ruleVersionId') END END AS rule_version_id,
    CASE WHEN rule_snapshot.type = 'object' THEN CASE WHEN json_type(rule_snapshot.value, '$.workDate') = 'text' THEN json_extract(rule_snapshot.value, '$.workDate') END END AS work_date
  FROM `hr_payslip_lines` AS payslip_line
  INNER JOIN `hr_payslips` AS payslip ON payslip.id = payslip_line.payslip_id
  CROSS JOIN json_each(
    CASE WHEN json_valid(payslip_line.explanation_json) AND json_type(payslip_line.explanation_json, '$.specialWorkdayRuleSnapshots') = 'array'
      THEN json_extract(payslip_line.explanation_json, '$.specialWorkdayRuleSnapshots')
      ELSE '[]'
    END
  ) AS rule_snapshot
  WHERE rule_snapshot.type = 'object'
) AS source
WHERE source.rule_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `hr_payroll_special_workday_sources` AS existing
  WHERE existing.payroll_run_id = source.payroll_run_id AND existing.rule_version_id = source.rule_version_id
);
