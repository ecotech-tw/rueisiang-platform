import { describe, expect, it } from "vitest";
import { fromHoursText, nextOvertimeRule, parseFromHours, parseToHours, toHoursText, type OvertimeRuleDraft } from "./SpecialWorkdays.js";

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
});
