import { describe, expect, it } from "vitest";
import { defaultActiveVersionId, fromHoursText, nextOvertimeRule, parseFromHours, parseToHours, toHoursText, type OvertimeRuleDraft } from "./SpecialWorkdays.js";

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

  it("套用時預設選目前仍有效的最新版本，不選已過期的第一版", () => {
    const version = (id: string, versionNumber: number, voidedAt: string | null = null) => ({
      id, ruleId: "rule-1", versionNumber, validFrom: `2026-0${versionNumber}-01`, validTo: null,
      wageKind: "fixed_hourly" as const, fixedAmountMinor: 100, multiplierPpm: null,
      workSource: "hourly" as const, note: "", voidedAt, voidedBy: null, allowances: [], overtimeRules: [],
    });
    expect(defaultActiveVersionId([{
      rule: { id: "rule-1", name: "特殊日", active: 1, revision: 1 },
      versions: [version("version-1", 1), version("version-2", 2), version("version-3", 3, "2026-03-01")],
    }])).toBe("version-2");
  });
});
