import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HrPayrollAdjustments, payrollAdjustmentPersonnelLabel } from "./PayrollAdjustments.js";
import type { PayrollAdjustment } from "./api.js";

const mocks = vi.hoisted(() => ({ useSession: vi.fn(), useHrQuery: vi.fn() }));
vi.mock("../../auth/session.js", () => ({ useSession: mocks.useSession }));
vi.mock("../../shell/usePageTitle.js", () => ({ usePageTitle: vi.fn() }));
vi.mock("./api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api.js")>(),
  useHrQuery: mocks.useHrQuery,
  useHrPersonnelRoster: () => ({ data: { employees: [] }, isPending: false, error: null }),
  useHrWrite: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));

const adjustment: PayrollAdjustment = {
  id: "adjustment-1", employmentId: "employment-1", effectivePeriodKey: "2026-09", reason: "補發",
  createdBy: "admin", createdAt: "2026-09-01", updatedBy: "admin", updatedAt: "2026-09-01", revision: 1,
  canEdit: true, employeeName: "王小明", employeeNumber: "E036",
  items: [{ id: "item-1", adjustmentId: "adjustment-1", itemName: "獎金", amountMinor: 10000, createdAt: "2026-09-01" }],
};
beforeEach(() => {
  mocks.useSession.mockReturnValue({ user: { isHrAdministrator: true }, permissions: new Set(["hr:payroll:read", "hr:payroll:calculate"]) });
  mocks.useHrQuery.mockReturnValue({ data: { adjustments: [adjustment, { ...adjustment, id: "locked", canEdit: false }] }, isPending: false, error: null });
});

describe("薪資加扣項操作欄", () => {
  it("可編輯列與鎖定列共用對齊容器，禁止圖示不是按鈕", () => {
    const markup = renderToStaticMarkup(createElement(HrPayrollAdjustments));
    const cells = [...markup.matchAll(/<td data-label="操作">([\s\S]*?)<\/td>/g)].map((match) => match[1]!);
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(cell).toContain('class="hr-payroll-adjustment-actions"');
    expect(cells[0]).toContain("編輯");
    expect(cells[0]).toContain("刪除");
    expect(cells[0]).not.toContain('class="button-row"');
    expect(cells[1]).toContain('role="img" aria-label="不能編輯或刪除"');
    expect(cells[1]).toContain('class="inline-flex size-6 shrink-0 items-center"');
    expect(cells[1]).toContain('<svg class="size-6 shrink-0"');
    expect(cells[1]).not.toContain("<button");
    expect(cells[1]).not.toContain("icon-button");
  });

  it("只有讀取權限時顯示禁止圖示與所需權限，不顯示可操作按鈕", () => {
    mocks.useSession.mockReturnValue({ user: { isHrAdministrator: true }, permissions: new Set(["hr:payroll:read"]) });
    const markup = renderToStaticMarkup(createElement(HrPayrollAdjustments));
    const cells = [...markup.matchAll(/<td data-label="操作">([\s\S]*?)<\/td>/g)].map((match) => match[1]!);
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell).toContain('role="img" aria-label="需要薪資試算權限才能編輯或刪除"');
      expect(cell).toContain('class="inline-flex size-6 shrink-0 items-center"');
      expect(cell).toContain('<svg class="size-6 shrink-0"');
      expect(cell).not.toContain("<button");
    }
    expect(markup).not.toContain("新增薪資加扣項");
    expect(markup).toContain("目前只有薪資檢視權限；新增、編輯與刪除需要「執行薪資試算」權限。");
  });
});

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
