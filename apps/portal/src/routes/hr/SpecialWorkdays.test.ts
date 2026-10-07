import { describe, expect, it } from "vitest";
import { datesInRange, defaultActiveRuleId, effectiveSpecialWorkdayVersion, filterSpecialWorkdayAssignments, fromHoursText, nextOvertimeRule, parseFromHours, parseToHours, remapAllowanceQuantities, toHoursText, type OvertimeRuleDraft } from "./SpecialWorkdays.js";

describe("特殊上班日加班級距的時數邊界", () => {
  it("把資料庫的第一個半小時索引顯示為 0.0 小時起算", () => {
    expect(fromHoursText(1)).toBe("0.0");
    expect(fromHoursText(5)).toBe("2.0");
    expect(toHoursText(4)).toBe("2.0");
  });

  it("把 0.0 小時起算的邊界轉成既有的半小時索引", () => {
    expect(parseFromHours("0")).toBe(1);
    expect(parseFromHours("2")).toBe(5);
    expect(parseFromHours("")).toBeNull();
    expect(parseFromHours("0.25")).toBeNull();
    expect(parseToHours("2")).toBe(4);
    expect(parseToHours("0")).toBeNull();
  });

  it("新增級距時沿用前一級的迄止，不再多跳 0.5 小時", () => {
    const previous: OvertimeRuleDraft = { fromHours: "0.0", toHours: "2.0", rateKind: "multiplier", amount: "133.33" };
    expect(nextOvertimeRule([]).fromHours).toBe("0.0");
    expect(nextOvertimeRule([previous]).fromHours).toBe("2.0");
  });

  it("套用時預設選目前仍有效的規則，不固定版本", () => {
    const version = (id: string, versionNumber: number, voidedAt: string | null = null) => ({
      id, ruleId: "rule-1", versionNumber, validFrom: `2026-0${versionNumber}-01`, validTo: null,
      wageKind: "fixed_hourly" as const, fixedAmountMinor: 100, multiplierPpm: null,
      workSource: "hourly" as const, note: "", voidedAt, voidedBy: null, allowances: [], overtimeRules: [],
    });
    expect(defaultActiveRuleId([{
      rule: { id: "rule-1", name: "特殊日", active: 1, revision: 1 },
      versions: [version("version-1", 1), version("version-2", 2), version("version-3", 3, "2026-03-01")],
    }])).toBe("rule-1");
  });

  it("日期區間包含開始日與結束日", () => {
    expect(datesInRange("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(datesInRange("2026-03-01", "2026-02-27")).toEqual([]);
  });

  it("跨規則版本的套用日期各自使用有效版本與補貼 ID", () => {
    const version = (id: string, versionNumber: number, validFrom: string, validTo: string | null, allowanceId: string, itemName: string) => ({
      id, ruleId: "rule-1", versionNumber, validFrom, validTo,
      wageKind: "fixed_hourly" as const, fixedAmountMinor: 100, multiplierPpm: null,
      workSource: "hourly" as const, note: "", voidedAt: null, voidedBy: null,
      allowances: [{ id: allowanceId, ruleVersionId: id, itemName, unitAmountMinor: 100 }], overtimeRules: [],
    });
    const first = version("version-1", 1, "2026-01-01", "2026-06-01", "allowance-1", "餐費");
    const second = version("version-2", 2, "2026-06-01", null, "allowance-2", "交通補貼");
    const rule = { rule: { id: "rule-1", name: "特殊日", active: 1, revision: 1 }, versions: [first, second] };
    expect(effectiveSpecialWorkdayVersion(rule, "2026-05-31")?.id).toBe("version-1");
    expect(effectiveSpecialWorkdayVersion(rule, "2026-06-01")?.id).toBe("version-2");
    expect(remapAllowanceQuantities(second, first, { "allowance-2": 3 })).toEqual([{ allowanceId: "allowance-1", quantity: 0 }]);
    expect(remapAllowanceQuantities(first, second, { "allowance-1": 2 })).toEqual([{ allowanceId: "allowance-2", quantity: 0 }]);
  });

  it("日期套用紀錄可以依搜尋、日期與薪資狀態篩選", () => {
    const rows = [
      { assignment: { id: "assignment-1", ruleId: "rule-1", employmentId: "employment-1", workerId: null, workDate: "2026-04-01", allowanceSnapshotJson: "[]", allowanceQuantity: 0, appliedAt: "2026-03-01" }, ruleName: "清明特殊日", includedInPayroll: false, currentVersionNumber: 1, currentVersionVoidedAt: null, currentWageKind: "multiplier" as const, employeeNumber: "E-001", employeeName: "王小明", workerName: null },
      { assignment: { id: "assignment-2", ruleId: "rule-2", employmentId: "employment-2", workerId: null, workDate: "2026-04-02", allowanceSnapshotJson: "[]", allowanceQuantity: 0, appliedAt: "2026-03-01" }, ruleName: "勞動節特殊日", includedInPayroll: true, currentVersionNumber: 1, currentVersionVoidedAt: null, currentWageKind: "fixed_hourly" as const, employeeNumber: "E-002", employeeName: "李小華", workerName: null },
    ];
    expect(filterSpecialWorkdayAssignments(rows, { search: "王小明", startDate: "", endDate: "", payrollStatus: "all" }).map((row) => row.assignment.id)).toEqual(["assignment-1"]);
    expect(filterSpecialWorkdayAssignments(rows, { search: "", startDate: "2026-04-02", endDate: "2026-04-02", payrollStatus: "all" }).map((row) => row.assignment.id)).toEqual(["assignment-2"]);
    expect(filterSpecialWorkdayAssignments(rows, { search: "", startDate: "", endDate: "", payrollStatus: "not_included" }).map((row) => row.assignment.id)).toEqual(["assignment-1"]);
  });
});
