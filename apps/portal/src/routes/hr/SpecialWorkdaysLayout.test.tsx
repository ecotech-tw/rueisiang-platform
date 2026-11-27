// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HrSpecialWorkdays } from "./SpecialWorkdays.js";
import type { SpecialWorkdayAssignment, SpecialWorkdayRule } from "./api.js";

const session = vi.hoisted(() => ({ permissions: new Set<string>() }));
vi.mock("../../auth/session.js", () => ({ useSession: () => session }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));

const rule: SpecialWorkdayRule = {
  rule: { id: "rule-1", name: "固定假日", active: 1, revision: 1 }, payrollReferenced: false,
  versions: [{ id: "version-1", ruleId: "rule-1", versionNumber: 1, validFrom: "2026-01-01", validTo: null, wageKind: "multiplier", fixedAmountMinor: null, multiplierPpm: 2_000_000, workSource: "manual", note: "", allowances: [], overtimeRules: [] }],
};
const assignment: SpecialWorkdayAssignment = {
  assignment: { id: "assignment-1", ruleId: "rule-1", employmentId: "employment-1", workerId: null, workDate: "2026-09-25", allowanceSnapshotJson: "[]", allowanceQuantity: 0, appliedAt: "2026-09-01" },
  ruleName: "固定假日", includedInPayroll: true, currentVersionNumber: 1, currentVersionVoidedAt: null, currentWageKind: "multiplier", employeeNumber: "E001", employeeName: "王小明", workerName: null,
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let ruleRows: SpecialWorkdayRule[];
let assignmentRows: SpecialWorkdayAssignment[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  session.permissions = new Set(["hr:office:read", "hr:office:write"]);
  ruleRows = [rule];
  assignmentRows = [assignment];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/special-workdays/rules")) return Response.json({ rules: ruleRows });
    if (String(input).endsWith("/special-workdays/assignments")) return Response.json({ assignments: assignmentRows });
    if (String(input).endsWith("/special-workdays/rules/rule-1/status")) return Response.json({ error: "停用規則失敗，請稍後再試。" }, { status: 500 });
    throw new Error(`未預期的請求：${String(input)}`);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={client}><HrSpecialWorkdays /></QueryClientProvider>));
}
function button(label: string) {
  const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  expect(node, `找不到按鈕：${label}`).toBeDefined();
  return node!;
}
async function switchView(label: string) {
  await act(async () => button(label).click());
}

it("預設只顯示撐滿剩餘高度的套用紀錄，規則檢視也獨立使用剩餘高度", async () => {
  await mount();
  expect(button("日期套用紀錄").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelectorAll("[data-panel]")).toHaveLength(1);
  expect(container.querySelector('[data-page="fills"] > [data-grows][aria-label="日期套用紀錄"]')).not.toBeNull();
  expect(container.querySelectorAll("table")).toHaveLength(1);
  expect(container.textContent).toContain("王小明");
  expect(container.textContent).not.toContain("規則主檔");
  expect(container.querySelector('button[aria-label^="刪除王小明"]:disabled')).not.toBeNull();

  await switchView("規則管理");
  expect(button("規則管理").getAttribute("aria-pressed")).toBe("true");
  expect(button("日期套用紀錄").getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelectorAll("[data-panel]")).toHaveLength(1);
  expect(container.querySelector('[data-page="fills"] > [data-grows][aria-label="規則管理"]')).not.toBeNull();
  expect(container.textContent).toContain("版本／期間");
  expect(container.textContent).not.toContain("王小明");
  expect(button("套用到人員日期").disabled).toBe(false);
  expect(button("新增規則")).toBeDefined();
});

it("操作失敗後切回紀錄仍保留表格保底，頁面捲動不依賴視窗高度門檻", async () => {
  await mount();
  await switchView("規則管理");
  await act(async () => button("停用").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("停用規則失敗");
  for (const view of ["日期套用紀錄", "規則管理"]) {
    await switchView(view);
    expect(container.querySelector('[data-page="fills"]')?.className).toContain("min-[760px]:overflow-y-auto");
    expect(container.querySelector("[data-grows]")?.className).toContain(":min-h-min");
    const table = container.querySelector("[data-table-scroll]");
    expect(table?.className).toContain("min-[760px]:[contain:size]");
    expect(table?.className).toContain(":min-h-[200px]");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("停用規則失敗");
  }
});

it("切換到規則管理再回來，日期篩選與空結果仍保留", async () => {
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="開始日期"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "2026-10-01");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("沒有符合條件的套用紀錄");
  await switchView("規則管理");
  await switchView("日期套用紀錄");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="開始日期"]')?.value).toBe("2026-10-01");
  expect(container.textContent).toContain("沒有符合條件的套用紀錄");
  await act(async () => button("清除篩選").click());
  expect(container.textContent).toContain("王小明");
});

it("輸入搜尋後立即切換分頁，尚未等待 400ms 也不會遺失文字", async () => {
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜尋套用紀錄"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "找不到的人員");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await switchView("規則管理");
  await switchView("日期套用紀錄");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="搜尋套用紀錄"]')?.value).toBe("找不到的人員");
  expect(container.textContent).toContain("沒有符合條件的套用紀錄");
});

it("沒有規則與套用紀錄時，兩個檢視各自顯示空狀態並停用套用", async () => {
  ruleRows = [];
  assignmentRows = [];
  await mount();
  expect(container.textContent).toContain("尚未有日期套用紀錄");
  expect(button("套用到人員日期").disabled).toBe(true);
  await switchView("規則管理");
  expect(container.textContent).toContain("尚未建立特殊上班日規則");
  expect(button("新增規則")).toBeDefined();
});

it("唯讀使用者可切換檢視，但不顯示寫入操作", async () => {
  session.permissions.delete("hr:office:write");
  await mount();
  expect(container.textContent).not.toContain("套用到人員日期");
  expect(container.textContent).not.toContain("新增規則");
  expect(container.querySelector('button[aria-label^="編輯"]')).toBeNull();
  await switchView("規則管理");
  expect(container.textContent).toContain("版本／期間");
  expect(container.querySelector('button[aria-label^="為固定假日"]')).toBeNull();
});
