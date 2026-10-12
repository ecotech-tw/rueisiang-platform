// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HrPayrollAdjustments } from "./PayrollAdjustments.js";
import type { Employee, PayrollAdjustment } from "./api.js";

const mocks = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../auth/session.js", () => ({ useSession: () => ({ user: { isHrAdministrator: true }, permissions: new Set(["hr:payroll:read", "hr:payroll:calculate"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: mocks.showToast }) }));

const employee: Employee = {
  personKind: "employee", employmentId: "employment-1", userId: "user-1", employeeNumber: "E036", legalName: "王小明",
  accountName: "王小明", displayName: "王小明", email: "wang@example.com", position: "同仁", supervisorUserId: null,
  supervisorName: null, userStatus: "active", employmentStatus: "active", revision: 1,
};
const adjustment: PayrollAdjustment = {
  id: "adjustment-1", employmentId: employee.employmentId!, effectivePeriodKey: "2026-09", reason: "補發",
  createdBy: "admin", createdAt: "2026-09-01", updatedBy: "admin", updatedAt: "2026-09-01", revision: 1,
  canEdit: true, employeeName: employee.legalName, employeeNumber: employee.employeeNumber,
  items: [{ id: "item-1", adjustmentId: "adjustment-1", itemName: "獎金", amountMinor: 10000, createdAt: "2026-09-01" }],
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let writes: RequestInit[];
let respond: (input: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  mocks.showToast.mockClear();
  writes = [];
  respond = () => Response.json({ id: adjustment.id });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { writes.push(init); return respond(init); }
    if (String(input).includes("/employees?")) return Response.json({ employees: [employee], total: 1, page: 1, pageSize: 100, hasMore: false });
    if (String(input).includes("/payroll/adjustments")) return Response.json({ adjustments: [adjustment] });
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
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrPayrollAdjustments /></QueryClientProvider></MemoryRouter>));
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label);
  expect(button, `找不到按鈕：${label}`).toBeDefined();
  await act(async () => button!.click());
}
async function input(label: string, value: string) {
  const field = [...document.querySelectorAll<HTMLLabelElement>("label")].find((node) => node.querySelector("span")?.childNodes[0]?.textContent === label);
  const control = field?.querySelector<HTMLInputElement>("input");
  expect(control, `找不到欄位：${label}`).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value);
    control!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submitForm() {
  const form = document.querySelector<HTMLFormElement>('[role="dialog"] form');
  expect(form).toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
async function prepareSave(method: "POST" | "PATCH") {
  await mount();
  await click(method === "POST" ? "新增薪資加扣項" : "編輯");
  if (method === "POST") {
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] .combobox-trigger')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.includes("王小明"))!.click());
    await input("項目名稱", "獎金");
    await input("金額（元）", "100");
    await input("加扣項原因", "補發");
  }
}

it.each([
  ["POST", "已新增薪資加扣項。"],
  ["PATCH", "已保存薪資加扣項修改。"],
] as const)("%s 成功後只通知一次", async (method, message) => {
  await prepareSave(method);
  expect(mocks.showToast).not.toHaveBeenCalled();
  await submitForm();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.method).toBe(method);
  expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith(message, "success");
});

it("刪除成功才通知一次，打開確認視窗不通知", async () => {
  await mount();
  await click("刪除");
  expect(mocks.showToast).not.toHaveBeenCalled();
  await click("刪除加扣項");
  expect(writes).toHaveLength(1);
  expect(writes[0]?.method).toBe("DELETE");
  expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith("已刪除薪資加扣項。", "success");
});

it.each(["POST", "PATCH", "DELETE"] as const)("%s 失敗沿用錯誤通知，不發成功通知", async (method) => {
  respond = () => Response.json({ error: "資料已被其他人修改。" }, { status: 409 });
  if (method === "DELETE") { await mount(); await click("刪除"); await click("刪除加扣項"); }
  else { await prepareSave(method); await submitForm(); }
  expect(writes).toHaveLength(1);
  expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith("資料已被其他人修改。", "danger");
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent).toContain("資料已被其他人修改。");
});

it("新增表單驗證未通過，不送請求也不通知成功", async () => {
  await mount(); await click("新增薪資加扣項"); await submitForm();
  expect(writes).toHaveLength(0);
  expect(mocks.showToast).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("請選擇人員。");
});

it("儲存等待回應時不先通知成功", async () => {
  let resolve!: (value: Response) => void;
  respond = () => new Promise<Response>((done) => { resolve = done; });
  await prepareSave("PATCH"); await submitForm();
  expect(writes).toHaveLength(1);
  expect(mocks.showToast).not.toHaveBeenCalled();
  expect(document.querySelector('button[aria-busy="true"]')).not.toBeNull();
  await act(async () => resolve(Response.json({ id: adjustment.id })));
  expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith("已保存薪資加扣項修改。", "success");
});
