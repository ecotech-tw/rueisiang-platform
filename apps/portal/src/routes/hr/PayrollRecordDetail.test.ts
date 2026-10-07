import { describe, expect, it } from "vitest";
import { payrollLineLabel, specialWorkdayDifferenceLabel } from "./PayrollRecordDetail.js";

describe("薪資明細項目文案", () => {
  it("業績獎金使用獎金設定名稱，讓多筆獎金可以區分", () => {
    const line = (lineKey: string, policyName: string) => ({
      lineKey,
      direction: "earning" as const,
      amountMinor: 1,
      explanation: { policyName },
    }) as Parameters<typeof payrollLineLabel>[0];

    expect([line("bonus_1", "西門櫃點獎金"), line("bonus_2", "個人業績獎金")].map(payrollLineLabel)).toEqual(["西門櫃點獎金", "個人業績獎金"]);
  });

  it("沒有獎金設定名稱的歷史明細保留通用文案", () => {
    const line = {
      lineKey: "bonus_1",
      direction: "earning" as const,
      amountMinor: 1,
      explanation: {},
    } as Parameters<typeof payrollLineLabel>[0];

    expect(payrollLineLabel(line)).toBe("業績獎金");
  });
});

describe("特殊上班日薪資差額文案", () => {
  it("正向差額顯示薪資加給，負向差額顯示薪資扣回", () => {
    const line = (direction: "earning" | "deduction") => ({
      lineKey: "special_workday",
      direction,
      amountMinor: 1,
      explanation: { ruleNames: ["夜間進／撤櫃"] },
    }) as Parameters<typeof specialWorkdayDifferenceLabel>[0];

    expect(specialWorkdayDifferenceLabel(line("earning"))).toBe("夜間進／撤櫃：薪資加給");
    expect(specialWorkdayDifferenceLabel(line("deduction"))).toBe("夜間進／撤櫃：薪資扣回");
  });
});
