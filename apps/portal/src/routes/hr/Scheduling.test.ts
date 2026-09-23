import { describe, expect, it } from "vitest";
import { firstQuickPersonId } from "./Scheduling.js";

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
