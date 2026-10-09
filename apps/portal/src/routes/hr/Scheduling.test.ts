import { describe, expect, it } from "vitest";
import { firstQuickPersonId, sameDayMultiScopeSchedules } from "./Scheduling.js";

describe("同日跨據點排班提醒", () => {
  const entry = (overrides: Partial<{ personKind: "employee" | "worker"; employmentId: string | null; workerId: string | null; workDate: string; scopeId: string; scopeName: string; personName: string; archivedAt: string | null }> = {}) => ({
    personKind: "employee" as const, employmentId: "employment-1", workerId: null, workDate: "2026-09-30", scopeId: "scope-a", scopeName: "西門櫃", personName: "王小明", archivedAt: null, ...overrides,
  });

  it("只提醒同一人同一天出現在多個據點，且忽略封存排班", () => {
    expect(sameDayMultiScopeSchedules([
      entry(),
      entry({ scopeId: "scope-b", scopeName: "信義櫃" }),
      entry({ workDate: "2026-10-01", scopeId: "scope-b", scopeName: "信義櫃" }),
      entry({ personKind: "worker", employmentId: null, workerId: "worker-1", scopeId: "scope-b", scopeName: "信義櫃", personName: "支援人員" }),
      entry({ scopeId: "scope-c", scopeName: "封存櫃", archivedAt: "2026-09-01" }),
    ])).toEqual([expect.objectContaining({ personId: "employment-1", personName: "王小明", workDate: "2026-09-30", scopeNames: ["西門櫃", "信義櫃"] })]);
  });
});

describe("快速排班的人員預設值", () => {
  const data = {
    employees: [{ employmentId: "employment-1" }],
    workers: [{ id: "worker-1" }],
  };

  it("切換到臨時支援時記住第一位支援人員", () => {
    expect(firstQuickPersonId(data, "worker")).toBe("worker-1");
  });

  it("切換回正式員工時沿用第一位員工，沒有名單則保持空值", () => {
    expect(firstQuickPersonId(data, "employee")).toBe("employment-1");
    expect(firstQuickPersonId({ employees: [], workers: [] }, "worker")).toBe("");
  });
});
