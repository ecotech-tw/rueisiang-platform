// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HrScheduleResponse } from "./api.js";
import { HrScheduling } from "./Scheduling.js";
import { useUnsavedChanges } from "../../shell/UnsavedChanges.js";

vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["hr:schedule:read", "hr:schedule:write"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../shell/UnsavedChanges.js", async () => { const { Link } = await import("react-router"); return { useConfirmLeave: () => async () => true, useUnsavedChanges: vi.fn(), GuardedNavLink: Link }; });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });
function data(revision = 2): HrScheduleResponse {
  return { periodKey: "2026-02", period: { start: "2026-02-01", end: "2026-03-01" }, version: { id: "version", revision, status: "published", locked: false, lockedAt: null }, scopes: [{ id: "store", name: "門市" }], calendar: Array.from({ length: 28 }, (_, index) => ({ date: `2026-02-${String(index + 1).padStart(2, "0")}`, dayType: "weekday", name: "", specialKind: "none", specialScopeIds: [], overridden: false })), employees: [{ employmentId: "employee", userId: "user", employeeNumber: "E1", name: "小明" }], workers: [], entries: [], shifts: [{ versionId: "shift", templateId: "early", scopeId: "store", name: "早班", dayType: "weekday", revision: 1, startSecond: 32400, endSecond: 64800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 }] };
}

async function renderPage(getFailures = 0, mutationStatus = 200, initial = data(), quickMode = true) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.setSystemTime(new Date("2026-02-01T00:00:00Z")); notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["hr", "/schedules?periodKey=2026-02"], initial);
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return Response.json(mutationStatus === 200 ? { id: "version", revision: 3 } : { error: "排班已被其他人修改，請重新整理。" }, { status: mutationStatus }); }
    if (getFailures-- > 0) return Response.json({ error: "重新載入暫時失敗" }, { status: 500 });
    return Response.json({ ...initial, version: { ...initial.version!, revision: 3 } });
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const click = async (label: string) => { await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrScheduling /></QueryClientProvider></MemoryRouter>));
  const dateButton = (day = "7") => [...container.querySelectorAll<HTMLButtonElement>(".hr-quick-day")].find((button) => button.textContent === day)!;
  if (quickMode) { await click("快速排班"); await act(async () => dateButton().click()); }
  return { client, writes, click, dateButton, cleanup: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

async function selectOption(label: string, text: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes(text))!.click());
}
function restrictedData(): HrScheduleResponse {
  const initial = data();
  initial.employees.push({ employmentId: "other", userId: "other-user", employeeNumber: "E2", name: "小華" });
  initial.workers = [{ id: "worker", name: "支援小美", active: 1 }, { id: "outside-worker", name: "其他支援", active: 1 }];
  initial.shifts[0]!.allowedPersonIds = ["other", "worker"];
  initial.shifts.push({ ...initial.shifts[0]!, templateId: "late", versionId: "late", name: "晚班", allowedPersonIds: ["employee"] }, { ...initial.shifts[0]!, templateId: "empty", versionId: "empty", name: "空名單", allowedPersonIds: [] });
  return initial;
}

describe("後台班別人員篩選", () => {
  it.each([true, false])("%s 快速模式：主動清空人員後不能新增，切換班別也不自動選回", async (quickMode) => {
    const page = await renderPage(0, 200, restrictedData(), quickMode);
    try {
      if (!quickMode) await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 新增排班"]')!.click());
      const label = quickMode ? "人員" : "新增排班人員";
      const input = () => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      await act(async () => input().closest(".combobox-group")!.querySelector<HTMLButtonElement>('[aria-label="清除選擇"]')!.click());
      expect(input().value).toBe("");
      expect(input().placeholder).toBe("請選擇人員");
      expect(document.body.textContent).not.toContain("此班別沒有可排的正式員工");
      await selectOption(quickMode ? "班別" : "新增排班班別", "晚班");
      expect(input().value).toBe("");
      const add = quickMode ? page.dateButton("8") : [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加入排班")!;
      expect(add.disabled).toBe(true);
      await act(async () => add.click());
      if (quickMode) {
        await page.click("儲存");
        expect(page.writes[0]!.entries).toEqual([expect.objectContaining({ employmentId: "other", workDate: "2026-02-07" })]);
      } else expect(page.writes).toHaveLength(0);
    } finally { await page.cleanup(); }
  });

  it.each([true, false])("%s 快速模式：自動選入的人員在新班別仍有效時保持不變", async (quickMode) => {
    const initial = restrictedData();
    initial.shifts.find((shift) => shift.templateId === "late")!.allowedPersonIds = ["employee", "other"];
    const page = await renderPage(0, 200, initial, quickMode);
    try {
      if (!quickMode) await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 新增排班"]')!.click());
      const label = quickMode ? "人員" : "新增排班人員";
      expect(document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value).toContain("小華");
      await selectOption(quickMode ? "班別" : "新增排班班別", "晚班");
      expect(document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value).toContain("小華");
      await act(async () => {
        if (quickMode) page.dateButton("8").click();
        else [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加入排班")!.click();
      });
      await page.click("儲存");
      expect(page.writes[0]!.entries).toContainEqual(expect.objectContaining({ employmentId: "other", shiftVersionId: "late" }));
    } finally { await page.cleanup(); }
  });

  it.each([true, false])("%s 快速模式：切據點保留兩邊都允許的目前人員", async (quickMode) => {
    const initial = restrictedData();
    initial.scopes.push({ id: "store-b", name: "B店" });
    initial.shifts.push({ ...initial.shifts[0]!, scopeId: "store-b", templateId: "b", versionId: "b", allowedPersonIds: ["employee", "other"] });
    const page = await renderPage(0, 200, initial, quickMode);
    try {
      if (!quickMode) await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 新增排班"]')!.click());
      await selectOption(quickMode ? "營運據點" : "新增排班據點", "B店");
      expect(document.querySelector<HTMLInputElement>(`[aria-label="${quickMode ? "人員" : "新增排班人員"}"]`)!.value).toContain("小華");
      await act(async () => {
        if (quickMode) page.dateButton("8").click();
        else [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加入排班")!.click();
      });
      await page.click("儲存");
      expect(page.writes[0]!.entries).toContainEqual(expect.objectContaining({ employmentId: "other", scopeId: "store-b", shiftVersionId: "b" }));
    } finally { await page.cleanup(); }
  });

  it("快速排班只列目前班別的正式員工與支援人員", async () => {
    const page = await renderPage(0, 200, restrictedData());
    try {
      expect((document.querySelector('[aria-label="人員"]') as HTMLInputElement).value).toContain("小華");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="開啟人員選單"]')!.click());
      expect(document.querySelector('[aria-label="人員類型"]')).toBeNull();
      expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual([expect.stringContaining("E2・小華"), expect.stringContaining("支援小美（支援）")]);
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("支援小美"))!.click());
      expect((document.querySelector('[aria-label="人員"]') as HTMLInputElement).value).toBe("支援小美（支援）");
      await act(async () => page.dateButton("8").click()); await page.click("儲存");
      expect(page.writes[0]!.entries).toEqual([expect.objectContaining({ employmentId: "other" }), expect.objectContaining({ workerId: "worker" })]);
    } finally { await page.cleanup(); }
  });

  it("只有支援人員的班別直接選人，不需要先切換類型", async () => {
    const initial = restrictedData(); initial.shifts[0]!.allowedPersonIds = ["worker"];
    const page = await renderPage(0, 200, initial);
    try {
      expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toBe("支援小美（支援）");
      expect(document.querySelector('[aria-label="人員類型"]')).toBeNull();
      await page.click("儲存");
      expect(page.writes[0]!.entries).toEqual([expect.objectContaining({ personKind: "worker", workerId: "worker", workDate: "2026-02-07" })]);
    } finally { await page.cleanup(); }
  });

  it("切班別或據點後重新選有效人員；空名單不能新增但可移除已排卡片", async () => {
    const initial = restrictedData();
    initial.scopes.push({ id: "store-b", name: "B店" });
    initial.shifts.push({ ...initial.shifts[0]!, scopeId: "store-b", templateId: "b", versionId: "b", allowedPersonIds: ["employee"] });
    const page = await renderPage(0, 200, initial);
    try {
      await selectOption("班別", "晚班");
      expect((document.querySelector('[aria-label="人員"]') as HTMLInputElement).value).toContain("小明");
      await act(async () => page.dateButton("8").click());
      await selectOption("班別", "空名單");
      expect(page.dateButton().disabled).toBe(true);
      await act(async () => page.dateButton("9").click());
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="移除 小華"]')!.click());
      await selectOption("營運據點", "B店");
      expect((document.querySelector('[aria-label="人員"]') as HTMLInputElement).value).toContain("小明");
      await act(async () => page.dateButton("10").click()); await page.click("儲存");
      expect(page.writes[0]!.entries).toEqual([expect.objectContaining({ employmentId: "employee", shiftVersionId: "late", workDate: "2026-02-08" }), expect.objectContaining({ employmentId: "employee", scopeId: "store-b", workDate: "2026-02-10" })]);
    } finally { await page.cleanup(); }
  });

  it("單日新增同樣依班別過濾並在切換類型時更新人員", async () => {
    const page = await renderPage(0, 200, restrictedData(), false);
    try {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 新增排班"]')!.click());
      expect((document.querySelector('[aria-label="新增排班人員"]') as HTMLInputElement).value).toContain("小華");
      await selectOption("新增排班班別", "晚班");
      expect((document.querySelector('[aria-label="新增排班人員"]') as HTMLInputElement).value).toContain("小明");
      await selectOption("新增排班班別", "空名單");
      expect([...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加入排班")!.disabled).toBe(true);
      await selectOption("新增排班班別", "早班");
      await selectOption("新增排班人員類型", "臨時支援");
      expect((document.querySelector('[aria-label="新增排班人員"]') as HTMLInputElement).value).toBe("支援小美");
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加入排班")!.click());
      await page.click("儲存"); expect(page.writes[0]!.entries).toEqual([expect.objectContaining({ workerId: "worker" })]);
    } finally { await page.cleanup(); }
  });
});

describe("後台排班差異草稿", () => {
  it("背景版本更新保留草稿，不能把新 revision 套到舊草稿覆蓋他人", async () => {
    const page = await renderPage();
    try {
      await act(async () => page.client.setQueryData(["hr", "/schedules?periodKey=2026-02"], data(3)));
      expect(document.body.textContent).toContain("未儲存草稿仍保留");
      expect(page.dateButton().getAttribute("aria-pressed")).toBe("true");
      expect(page.dateButton().disabled).toBe(true);
      await page.click("儲存"); expect(page.writes).toHaveLength(0);
    } finally { await page.cleanup(); }
  });
  it("409 後自動重抓並保留草稿，明確接受新基準後才以新 revision 儲存", async () => {
    const page = await renderPage(0, 409);
    try {
      await page.click("儲存");
      expect(document.body.textContent).toContain("未儲存草稿仍保留");
      expect(page.dateButton().getAttribute("aria-pressed")).toBe("true");
      expect(page.dateButton().disabled).toBe(true);
      await page.click("儲存"); expect(page.writes).toHaveLength(1);
      await page.click("放棄草稿並載入最新班表");
      await act(async () => page.dateButton().click());
      await page.click("儲存");
      expect(page.writes[1]!.revision).toBe(3);
    } finally { await page.cleanup(); }
  });
  it("PATCH 成功但 GET 失敗時清除未儲存警告，能重抓但不能重送差異", async () => {
    const page = await renderPage(1);
    try {
      await page.click("儲存");
      expect(document.body.textContent).toContain("排班已儲存並生效，但載入最新班表失敗");
      expect(document.body.textContent).toContain("不需要再次儲存");
      expect(vi.mocked(useUnsavedChanges).mock.calls.at(-1)?.[0]).toBe(false);
      expect(page.writes).toHaveLength(1);
      await page.click("重新載入班表");
      expect(document.body.textContent).not.toContain("重新載入暫時失敗");
      expect(document.body.textContent).not.toContain("尚未儲存");
      expect(page.writes).toHaveLength(1);
    } finally { await page.cleanup(); }
  });
  it("保存後 GET 失敗，但背景恢復取得已保存 revision 時會自動解除待重抓狀態", async () => {
    const page = await renderPage(1);
    try {
      await page.click("儲存");
      expect(document.body.textContent).toContain("載入最新班表失敗");
      await act(async () => page.client.setQueryData(["hr", "/schedules?periodKey=2026-02"], data(3)));
      expect(document.body.textContent).not.toContain("載入最新班表失敗");
      expect(page.dateButton().disabled).toBe(false);
      expect(page.writes).toHaveLength(1);
      await act(async () => page.dateButton().click());
      expect(document.body.textContent).toContain("尚未儲存");
    } finally { await page.cleanup(); }
  });
  it("儲存送出差異後更新基準，不把自己成功的變更誤當外部衝突", async () => {
    const page = await renderPage();
    try {
      await page.click("儲存");
      expect(page.writes).toEqual([expect.objectContaining({ revision: 2, entries: [expect.objectContaining({ employmentId: "employee", workDate: "2026-02-07" })], removedIds: [], refreshIds: [] })]);
      expect(document.body.textContent).not.toContain("未儲存草稿仍保留");
      expect(document.body.textContent).not.toContain("尚未儲存");
    } finally { await page.cleanup(); }
  });
});
