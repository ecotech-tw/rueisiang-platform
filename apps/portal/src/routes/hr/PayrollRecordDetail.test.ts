import { describe, expect, it } from "vitest";
import { specialWorkdayDifferenceLabel } from "./PayrollRecordDetail.js";

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
