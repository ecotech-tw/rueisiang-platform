// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { HrShifts } from "./Shifts.js";
import type { HrShiftsResponse } from "./api.js";

const showToast = vi.fn();
vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["hr:schedule:read", "hr:schedule:write"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: showToast }) }));

const initialShifts: HrShiftsResponse = {
  scopes: [{ id: "store", name: "門市" }],
  shifts: [
    { versionId: "v1", templateId: "t1", scopeId: "store", name: "早班", dayType: "weekday", revision: 1, startSecond: 32400, endSecond: 64800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 },
    { versionId: "v2", templateId: "t2", scopeId: "store", name: "晚班", dayType: "weekday", revision: 1, startSecond: 36000, endSecond: 72000, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 },
  ],
};
const managerData = { scopes: [{ id: "store", name: "門市", userId: null, revision: 0 }], candidates: [] };

afterEach(() => { vi.unstubAllGlobals(); showToast.mockClear(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });

it("時間可手動輸入並驗證 HH:mm，班別名單可多選後一起儲存", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const initial = { ...initialShifts, shifts: initialShifts.shifts.slice(0, 1).map((shift) => ({ ...shift, allowedPersonIds: [] })), people: [{ id: "employee", employeeNumber: "E1", name: "小明", personKind: "employee" }] };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return Response.json({ revision: 2 }); }
    return Response.json(String(input).endsWith("/schedule-managers") ? managerData : initial);
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const change = async (value: string) => act(async () => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="早班平日開始時間"]')!;
    Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = async () => act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "儲存")!.click());
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrShifts /></QueryClientProvider></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="編輯 門市 的班別與排班負責人"]')!.click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="早班平日開始時間"]')!.type).toBe("text");
    expect(document.body.textContent).not.toContain("每個據點指定一位在職員工");
    expect(document.body.textContent).not.toContain("時間可直接輸入，格式為");
    expect(document.querySelector('[aria-label="早班前台人員範圍"]')).toBeNull();
    const picker = document.querySelector<HTMLInputElement>('[aria-label="早班平日開始時間時間選擇器"]')!;
    const showPicker = vi.fn(); Object.assign(picker, { showPicker });
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="點選早班平日開始時間"]')!.click());
    expect(showPicker).toHaveBeenCalledOnce();
    await change("25:00"); await save();
    expect(document.body.textContent).toContain("請輸入有效的 HH:mm"); expect(writes).toHaveLength(0);
    await change("09:30");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="開啟早班排班人員選單"]')!.click());
    await act(async () => ([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("小明")))!.click());
    await save();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ allowedPersonIds: ["employee"], times: [{ dayType: "weekday", startTime: "09:30", endTime: "18:00" }] });
  } finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
});

it("舊不限名單直接預選所有有效人員，開啟不產生變更，清空後存成空名單", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const initial = { ...initialShifts, shifts: initialShifts.shifts.slice(0, 1), people: [{ id: "employee", employeeNumber: "E1", name: "小明", personKind: "employee" }, { id: "worker", employeeNumber: "W1", name: "小華", personKind: "worker" }] };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return Response.json({ revision: 2 }); }
    return Response.json(String(input).endsWith("/schedule-managers") ? managerData : initial);
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrShifts /></QueryClientProvider></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="編輯 門市 的班別與排班負責人"]')!.click());
    expect(document.body.textContent).toContain("E1・小明"); expect(document.body.textContent).toContain("W1・小華（支援）");
    const save = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "儲存")!;
    expect(save().disabled).toBe(true);
    // 欄位包在 <label> 裡，label 的點擊會轉給它對到的控制項：對到第一顆移除鈕的話，點欄位空白處就是移除第一位。
    expect(document.querySelector<HTMLLabelElement>(".shift-members label")!.control).toBe(document.querySelector('input[aria-label="早班排班人員"]'));
    await act(async () => document.querySelector<HTMLElement>(".shift-members label > span")!.click());
    expect(document.body.textContent).toContain("E1・小明"); expect(save().disabled).toBe(true);
    await act(async () => document.querySelector<HTMLElement>('[aria-label="移除E1・小明"]')!.click());
    expect(document.querySelector('[aria-label="移除E1・小明"]')).toBeNull(); expect(save().disabled).toBe(false);
    await act(async () => document.querySelector<HTMLButtonElement>('.shift-members [aria-label="清除全部選擇"]')!.click());
    await act(async () => save().click()); expect(writes[0]!.allowedPersonIds).toEqual([]);
  } finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
});

it("排班負責人可選尚未啟用或停用帳號的員工，顯示狀態並保存穩定 userId", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const managers = { ...managerData, candidates: [{ userId: "invited", employeeNumber: "E1", name: "待啟用同仁", userStatus: "invited" }, { userId: "disabled", employeeNumber: "E2", name: "停用同仁", userStatus: "disabled" }] };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return Response.json({ revision: 1 }); }
    return Response.json(String(input).endsWith("/schedule-managers") ? managers : initialShifts);
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrShifts /></QueryClientProvider></MemoryRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="編輯 門市 的班別與排班負責人"]')!.click());
    expect(document.querySelectorAll(".shift-group")).toHaveLength(2);
    expect(document.querySelector(".shift-group-head .field > span")?.textContent).toContain("班別名稱");
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="開啟排班負責人選單"]')!.click());
    expect(document.body.textContent).toContain("待啟用同仁（尚未啟用）"); expect(document.body.textContent).toContain("停用同仁（帳號停用）");
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("待啟用同仁"))!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "儲存")!.click());
    expect(writes).toEqual([{ userId: "invited", revision: 0 }]);
  } finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
});

it("部分儲存後重新載入並關閉舊草稿，避免用過期 revision 重試", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let shifts = initialShifts;
  let patchCount = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/shift-templates") && !init?.method) return Response.json(shifts);
    if (path.endsWith("/schedule-managers") && !init?.method) return Response.json(managerData);
    if (path.includes("/shift-templates/") && init?.method === "PATCH") {
      patchCount += 1;
      if (patchCount === 2) return Response.json({ error: "班別已被其他人修改，請重新整理。" }, { status: 409 });
      const templateId = path.split("/").at(-1);
      const values = JSON.parse(String(init.body)) as { name: string };
      shifts = { ...shifts, shifts: shifts.shifts.map((shift) => shift.templateId === templateId ? { ...shift, name: values.name, revision: shift.revision + 1 } : shift) };
      return Response.json({ id: templateId, revision: 2 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });

  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrShifts /></QueryClientProvider></MemoryRouter>));
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="編輯 門市 的班別與排班負責人"]')!.click(); });
    const changeName = async (label: string, value: string) => act(async () => {
      const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await changeName("早班名稱", "早班改名");
    await changeName("晚班名稱", "晚班改名");
    await act(async () => { [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "儲存")!.click(); });
    // 等對話框真的從畫面上消失，不賭一個固定的毫秒數：兩次 PATCH、重新載入與收合都要時間，
    // CI 的機器慢一點，固定等 260ms 就會早一步檢查而失敗。每一小段各包一個 act——
    // React 的更新要等 act 結束才會套到畫面上，整段等在同一個 act 裡永遠看不到它關掉。
    const deadline = Date.now() + 3_000;
    while (document.body.querySelector('[role="dialog"]') && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }

    expect(patchCount).toBe(2);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("早班改名");
    expect(container.textContent).toContain("晚班");
    expect(container.textContent).not.toContain("晚班改名");
    expect(showToast).toHaveBeenCalledWith("部分設定已儲存。請重新開啟編輯視窗確認，再完成其他變更。", "danger");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});
