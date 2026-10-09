import { describe, expect, it } from "vitest";
import { payrollAdjustmentPersonnelLabel } from "./PayrollAdjustments.js";

describe("薪資加扣項人員選項", () => {
  it("支援人員優先顯示姓名，保留編號供辨識與搜尋", () => {
    expect(payrollAdjustmentPersonnelLabel({ personKind: "worker", legalName: "鄭宜瑄", employeeNumber: "W-長識別碼" })).toBe("鄭宜瑄（支援人員）・W-長識別碼");
  });

  it("正式員工維持員工編號在前", () => {
    expect(payrollAdjustmentPersonnelLabel({ personKind: "employee", legalName: "王小明", employeeNumber: "E036" })).toBe("E036・王小明");
  });

  it("支援人員缺少姓名時退回顯示編號", () => {
    expect(payrollAdjustmentPersonnelLabel({ personKind: "worker", legalName: "  ", employeeNumber: "W-長識別碼" })).toBe("W-長識別碼（支援人員）");
  });
});
