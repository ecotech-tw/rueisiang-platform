// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleChanges, type HrScheduleResponse, type ScheduleEntry } from "@rueisiang/db/schedule-draft";
import { HrScheduling } from "./Scheduling.js";

const shift = { versionId: "weekday", templateId: "early", scopeId: "store", name: "早班", dayType: "weekday" as const, revision: 1, startSecond: 32400, endSecond: 64800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 };
const savedEntry: ScheduleEntry = { id: "saved", scheduleVersionId: "version", personKind: "employee", employmentId: "employee", workerId: null, scopeId: "store", shiftVersionId: "weekday", shiftGroupId: "group", workDate: "2026-02-06", startsAt: "2026-02-06 09:00:00", endsAt: "2026-02-06 18:00:00", standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1, attendanceStatus: "scheduled", employeeNumber: "E1", personName: "小明", archivedAt: null, scopeName: "門市", shiftName: "早班" };
function data(locked = false): HrScheduleResponse {
  return { periodKey: "2026-02", period: { start: "2026-02-01", end: "2026-03-01" }, version: { id: "version", revision: 2, status: "published", locked, lockedAt: locked ? "now" : null }, scopes: [{ id: "store", name: "門市" }], employees: [{ employmentId: "employee", userId: "user", employeeNumber: "E1", name: "小明" }], workers: [], shifts: [shift, { ...shift, versionId: "weekend", dayType: "weekend", startSecond: 36000, endSecond: 68400, requiredHeadcount: 2 }], entries: [savedEntry], calendar: Array.from({ length: 28 }, (_, index) => ({ date: `2026-02-${String(index + 1).padStart(2, "0")}`, dayType: index === 6 ? "weekend" as const : "weekday" as const, name: "", specialKind: "none" as const, specialScopeIds: [], overridden: false })) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });

async function renderPage(initial: HrScheduleResponse, mutationStatus = 200, getFailures = 0) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
  notifyManager.setScheduler(queueMicrotask);
  // 無 loader 的 router 測試不需要 signal；Node Request 不接受 JSDOM 的 AbortSignal。
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest { constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }); } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["hr", "/me/schedule-scopes"], { scopes: [{ id: "store", name: "門市" }] });
  client.setQueryData(["hr", "/me/schedules?periodKey=2026-02&scopeId=store"], initial);
  const writes: Array<{ path: string; method: string; values: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push({ path: String(path), method: init.method, values: JSON.parse(String(init.body)) });
      return Response.json(mutationStatus === 200 ? { id: "version", revision: 3 } : { error: "同一據點排班重疊，草稿仍保留" }, { status: mutationStatus });
    }
    if (getFailures-- > 0) return Response.json({ error: "最新班表暫時無法載入" }, { status: 500 });
    return Response.json({ ...initial, version: { ...initial.version, revision: 3 } });
  });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const router = createMemoryRouter([{ path: "*", element: <Routes><Route path="/scheduling" element={<HrScheduling />} /><Route path="/profile" element={<p>個人頁</p>} /><Route path="/work" element={<p>工作分類</p>} /></Routes> }], { initialEntries: ["/profile", "/scheduling", "/profile"], initialIndex: 1 });
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  return { client, writes, router, click: async (label: string) => { await act(async () => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label); expect(button, `找不到按鈕「${label}」；目前按鈕：${[...document.querySelectorAll("button")].map((item) => item.textContent).join("／")}`).toBeDefined(); button!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); }); }, clickDate: async (date: string) => { await act(async () => (container.querySelector(`[aria-label="${date} 排班"]`) as HTMLButtonElement).click()); }, save: async () => { await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "儲存")!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); }); }, cleanup: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

async function renderMobilePage(initial: HrScheduleResponse, mutationStatus = 200, getFailures = 0) {
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  const page = await renderPage(initial, mutationStatus, getFailures);
  return { ...page, cleanup: async () => {
    await page.cleanup();
    if (original) Object.defineProperty(window, "matchMedia", original);
    else Reflect.deleteProperty(window, "matchMedia");
  } };
}

async function openMobileQuick() {
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "快速排班")!.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe("HR 前台快速排班", () => {
  it("單一選單同時列正式與支援人員，選支援直接保存正確身分", async () => {
    const initial = data(); initial.workers = [{ id: "worker", name: "支援小美", active: 1 }];
    const page = await renderPage(initial);
    try {
      expect(document.body.textContent).not.toContain("人員類型");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="開啟人員選單"]')!.click());
      expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual([expect.stringContaining("E1・小明"), expect.stringContaining("支援小美（支援）")]);
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("支援小美"))!.click());
      await page.clickDate("2026-02-07"); await page.save();
      expect(page.writes[0]!.values.entries).toEqual([expect.objectContaining({ personKind: "worker", workerId: "worker", shiftVersionId: "weekend" })]);
    } finally { await page.cleanup(); }
  });

  it("主動清空不重選，切班別仍保留有效人員，空名單恢復可以自動選支援", async () => {
    const initial = data(); initial.workers = [{ id: "worker", name: "支援小美", active: 1 }];
    initial.shifts = [{ ...shift, allowedPersonIds: ["worker"] }, { ...shift, templateId: "late", versionId: "late", name: "晚班", allowedPersonIds: null }, { ...shift, templateId: "empty", versionId: "empty", name: "空名單", allowedPersonIds: [] }];
    const page = await renderPage(initial);
    const select = async (text: string) => {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="班別"]')!.click());
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes(text))!.click());
    };
    try {
      expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toContain("支援小美");
      await select("晚班"); expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toContain("支援小美");
      await select("空名單"); expect(document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 排班"]')!.disabled).toBe(true);
      await select("早班"); expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toContain("支援小美");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="清除選擇"]')!.click());
      expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toBe("");
      await select("晚班"); expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toBe("");
      expect(document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 排班"]')!.disabled).toBe(true);
      await page.clickDate("2026-02-07"); await page.save(); expect(page.writes).toHaveLength(0);
    } finally { await page.cleanup(); }
  });

  it("切換班別後人員名單跟著限制，不沿用未納入的人員", async () => {
    const initial = data();
    initial.employees.push({ employmentId: "other", userId: "other-user", employeeNumber: "E2", name: "小華" });
    initial.shifts = [...initial.shifts.map((shift) => ({ ...shift, allowedPersonIds: ["employee"] })), { ...shift, name: "晚班", templateId: "late", versionId: "late-weekday", allowedPersonIds: ["other"] }];
    const page = await renderPage(initial);
    try {
      expect((document.querySelector('[aria-label="人員"]') as HTMLInputElement).value).toContain("小明");
      await act(async () => (document.querySelector('[aria-label="班別"]') as HTMLButtonElement).click());
      await act(async () => ([...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes("晚班")) as HTMLElement).click());
      expect((document.querySelector('[aria-label="人員"]') as HTMLInputElement).value).toContain("小華");
      await page.clickDate("2026-02-07"); await page.save();
      expect(page.writes[0]!.values.entries).toMatchObject([{ employmentId: "other" }]);
    } finally { await page.cleanup(); }
  });

  it("沒有納入人員時不能點日期，既有排班仍可由卡片移除", async () => {
    const initial = data(); initial.shifts = initial.shifts.map((shift) => ({ ...shift, allowedPersonIds: [] }));
    const page = await renderPage(initial);
    try {
      expect(document.body.textContent).toContain("尚未納入可排人員");
      expect((document.querySelector('[aria-label="2026-02-07 排班"]') as HTMLButtonElement).disabled).toBe(true);
      expect(document.querySelector('[aria-label="移除 2026-02-06 小明 早班"]')).not.toBeNull();
      await act(async () => (document.querySelector('[aria-label="移除 2026-02-06 小明 早班"]') as HTMLButtonElement).click());
      await page.save(); expect(page.writes[0]!.values.removedIds).toEqual(["saved"]);
    } finally { await page.cleanup(); }
  });

  it("點日期切換班表，儲存只送差異，週末使用對應版本", async () => {
    const page = await renderPage(data());
    try {
      await page.clickDate("2026-02-07");
      expect(document.body.textContent).toContain("尚未儲存：新增 1 筆、移除 0 筆");
      await page.save();
      expect(page.writes).toHaveLength(1);
      expect(page.writes[0]).toMatchObject({ method: "PATCH", values: { revision: 2, scopeId: "store", entries: [{ employmentId: "employee", workDate: "2026-02-07", shiftVersionId: "weekend" }], removedIds: [], refreshIds: [] } });
      expect((page.writes[0]!.values.entries as unknown[])).toHaveLength(1);
      expect(document.body.textContent).not.toContain("排班已儲存並生效，不需送審");
    } finally { await page.cleanup(); }
  });

  it("手機點日期先看當日明細，再用快速排班新增並儲存", async () => {
    const initial = data(); initial.workers = [{ id: "worker", name: "支援小美", active: 1 }];
    const page = await renderMobilePage(initial);
    try {
      await page.clickDate("2026-02-07");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.body.textContent).toContain("2026-02-07");
      expect(document.body.textContent).toContain("這一天尚無排班。");
      expect(document.body.textContent).not.toContain("尚未儲存：新增 1 筆");
      await openMobileQuick();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.querySelector('h1')!.textContent).toBe("快速排班");
      expect(document.querySelector('[aria-label="據點月曆"]')).toBeNull();
      await act(async () => (document.querySelector('[aria-label="開啟人員選單"]') as HTMLButtonElement).click());
      await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("支援小美"))!.click());
      for (const day of ["07", "08", "09", "09"]) await act(async () => (document.querySelector(`[aria-label="2026-02-${day} 快速排班"]`) as HTMLButtonElement).click());
      expect(document.querySelector<HTMLInputElement>('[aria-label="人員"]')!.value).toContain("支援小美");
      expect(document.body.textContent).toContain("尚未儲存：新增 2 筆");
      await page.click("儲存排班");
      expect(page.writes[0]!.values.entries).toMatchObject([
        { personKind: "worker", workerId: "worker", workDate: "2026-02-07", shiftVersionId: "weekend" },
        { personKind: "worker", workerId: "worker", workDate: "2026-02-08", shiftVersionId: "weekday" },
      ]);
    } finally { await page.cleanup(); }
  });

  it("手機直接進入同頁快速模式，返回視同儲存並保留日期差異", async () => {
    const page = await renderMobilePage(data());
    try {
      await page.click("快速排班");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(document.querySelector("h1"));
      expect(document.querySelector('[aria-label="營運據點"]')).toBeNull();
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await page.click("返回月曆");
      expect(document.querySelector("h1")!.textContent).toBe("排班");
      expect(document.body.textContent).not.toContain("尚未儲存：新增 1 筆");
      expect(document.querySelector('[aria-label="營運據點"]')).not.toBeNull();
      expect(page.writes).toHaveLength(1);
      expect(page.writes[0]!.values.entries).toMatchObject([{ workDate: "2026-02-07" }]);
    } finally { await page.cleanup(); }
  });

  it("手機一般月曆沒有儲存或操作說明，無變更返回不送 PATCH，首頁返回工作", async () => {
    const page = await renderMobilePage(data());
    try {
      expect([...document.querySelectorAll("button")].some((button) => button.textContent === "儲存")).toBe(false);
      expect(document.body.textContent).not.toContain("選好人員與班別");
      await page.click("快速排班"); await page.click("返回月曆");
      expect(page.writes).toHaveLength(0);
      await page.click("返回工作");
      expect(page.router.state.location.pathname).toBe("/work");
    } finally { await page.cleanup(); }
  });

  it.each([-1, 1, "/profile"] as const)("手機快速模式由 %s 離頁先保存，成功才導覽且不詢問放棄", async (target) => {
    const page = await renderMobilePage(data());
    const confirm = vi.spyOn(window, "confirm");
    try {
      await page.click("快速排班");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await act(async () => { if (typeof target === "number") await page.router.navigate(target); else await page.router.navigate(target); await new Promise((resolve) => setTimeout(resolve, 20)); });
      await vi.waitFor(() => expect(page.router.state.location.pathname).toBe("/profile"));
      expect(page.writes).toHaveLength(1);
      expect(page.writes[0]!.values.entries).toMatchObject([{ workDate: "2026-02-07" }]);
      expect(confirm).not.toHaveBeenCalled();
    } finally { await page.cleanup(); }
  });

  it("手機快速模式離頁或返回保存失敗，保留模式和日期且過期版本不重送", async () => {
    const page = await renderMobilePage(data(), 409);
    try {
      await page.click("快速排班");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await act(async () => { await page.router.navigate("/profile"); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(page.router.state.location.pathname).toBe("/scheduling");
      expect(document.querySelector("h1")!.textContent).toBe("快速排班");
      expect(document.querySelector('[aria-label="2026-02-07 快速排班"]')!.getAttribute("aria-pressed")).toBe("true");
      expect(document.body.textContent).toContain("同一據點排班重疊");
      await page.click("返回月曆");
      expect(document.querySelector("h1")!.textContent).toBe("快速排班");
      expect(page.writes).toHaveLength(1);
    } finally { await page.cleanup(); }
  });

  it("手機快速模式 PATCH 成功但重抓失敗可返回，不能重送同一份差異", async () => {
    const page = await renderMobilePage(data(), 200, 1);
    try {
      await page.click("快速排班");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await page.click("返回月曆");
      expect(document.querySelector("h1")!.textContent).toBe("排班");
      expect(document.body.textContent).toContain("已儲存，重新載入班表");
      await page.click("快速排班"); await page.click("返回月曆");
      expect(page.writes).toHaveLength(1);
      await page.click("返回工作");
      expect(page.router.state.location.pathname).toBe("/work");
    } finally { await page.cleanup(); }
  });

  it("手機快速模式連點返回與儲存只送一次，PATCH 與 GET 都完成前不能離開", async () => {
    const page = await renderMobilePage(data());
    const originalFetch = globalThis.fetch;
    let finishPatch!: () => void; let finishGet!: () => void;
    const patchGate = new Promise<void>((resolve) => { finishPatch = resolve; });
    const getGate = new Promise<void>((resolve) => { finishGet = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      await (init?.method === "PATCH" ? patchGate : getGate);
      return response;
    });
    try {
      await page.click("快速排班");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await act(async () => {
        const back = document.querySelector<HTMLButtonElement>('[aria-label="返回月曆"]')!;
        back.click(); back.click();
        [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "儲存排班")!.click();
      });
      expect(page.writes).toHaveLength(1);
      await act(async () => { finishPatch(); await new Promise((resolve) => setTimeout(resolve, 10)); });
      expect(document.querySelector("h1")!.textContent).toBe("快速排班");
      await act(async () => { await page.router.navigate("/profile"); });
      expect(page.router.state.location.pathname).toBe("/scheduling");
      await act(async () => { finishGet(); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(document.querySelector("h1")!.textContent).toBe("排班");
      expect(page.writes).toHaveLength(1);
    } finally { finishPatch(); finishGet(); await page.cleanup(); }
  });

  it("自動保存途中新的導覽請求被拒絕，不放行已重設的 blocker", async () => {
    const page = await renderMobilePage(data());
    const originalFetch = globalThis.fetch;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (init?.method === "PATCH") await gate;
      return response;
    });
    try {
      await page.click("快速排班");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await act(async () => { await page.router.navigate("/profile"); });
      expect(page.router.state.location.pathname).toBe("/scheduling");
      expect(page.writes).toHaveLength(1);
      await act(async () => { await page.router.navigate("/work"); });
      await act(async () => { finish(); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(page.router.state.location.pathname).toBe("/scheduling");
      await page.click("返回月曆");
      expect(page.writes).toHaveLength(1);
    } finally { finish(); await page.cleanup(); }
  });

  it("手機同頁快速排班儲存中不能返回月曆或離頁，完成後回一般模式", async () => {
    const page = await renderMobilePage(data());
    const originalFetch = globalThis.fetch;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (init?.method === "PATCH") await pending;
      return response;
    });
    try {
      await page.click("快速排班");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await page.click("儲存排班");
      expect(document.querySelector<HTMLButtonElement>('[aria-label="返回月曆"]')!.disabled).toBe(true);
      await page.click("返回月曆"); expect(document.querySelector("h1")!.textContent).toBe("快速排班");
      const confirm = vi.spyOn(window, "confirm");
      await act(async () => { await page.router.navigate("/profile"); });
      expect(page.router.state.location.pathname).toBe("/scheduling"); expect(confirm).not.toHaveBeenCalled();
      await act(async () => { finish(); await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(page.router.state.location.pathname).toBe("/scheduling");
      expect(document.querySelector("h1")!.textContent).toBe("排班");
    } finally { finish(); await page.cleanup(); }
  });

  it("手機空名單仍可檢視並移除歷史排班，但不能新增", async () => {
    const initial = data(); initial.shifts = initial.shifts.map((item) => ({ ...item, allowedPersonIds: [] }));
    const page = await renderMobilePage(initial);
    try {
      await page.clickDate("2026-02-06");
      await openMobileQuick();
      expect(document.body.textContent).toContain("尚未納入可排人員");
      expect(document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.disabled).toBe(true);
      await page.click("返回月曆");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
      await page.clickDate("2026-02-06");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="移除 2026-02-06 小明 早班"]')!.click());
      await page.click("返回月曆");
      expect(page.writes[0]!.values.removedIds).toEqual(["saved"]);
    } finally { await page.cleanup(); }
  });

  it("手機節慶日期以綠點標示，已有其他人排班以粉橘底與圖例說明", async () => {
    const initial = data();
    initial.employees.push({ employmentId: "other", userId: "other", employeeNumber: "E2", name: "小華" });
    initial.entries.push({ ...savedEntry, id: "other-entry", employmentId: "other", employeeNumber: "E2", personName: "小華", workDate: "2026-02-07" });
    initial.calendar[6]!.name = "公司節慶"; initial.calendar[6]!.overridden = true;
    const page = await renderMobilePage(initial);
    try {
      await page.click("快速排班");
      const holiday = document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!;
      expect(holiday.className).toContain("bg-tone-peach/15");
      expect(holiday.querySelector(".bg-ok")).not.toBeNull();
      expect(document.querySelector('[aria-label="月曆圖例"]')!.textContent).toContain("節慶／特別日");
      expect(document.querySelector('[aria-label="月曆圖例"]')!.textContent).toContain("其他人已排班");
      expect(holiday.getAttribute("aria-description")).toContain("公司行事曆特別日");
      await act(async () => holiday.click());
      expect(holiday.getAttribute("aria-pressed")).toBe("true");
      expect(holiday.className).toContain("bg-tone-peach/15");
      expect(holiday.className).toContain("ring-brand-dark");
      expect(holiday.querySelector(".bg-ok")).not.toBeNull();
    } finally { await page.cleanup(); }
  });

  it("綠點只標示公司設定日期，據點限定災防日不誤標其他店", async () => {
    const initial = data();
    initial.calendar[5] = { ...initial.calendar[5]!, name: "颱風停班", specialKind: "typhoon_stop", specialScopeIds: ["elsewhere"], overridden: true };
    initial.calendar[6]!.overridden = false;
    initial.calendar[7]!.overridden = true;
    const page = await renderMobilePage(initial);
    try {
      expect(document.querySelector('[aria-label="2026-02-06 排班"] .bg-ok')).toBeNull();
      expect(document.querySelector('[aria-label="2026-02-07 排班"] .bg-ok')).toBeNull();
      expect(document.querySelector('[aria-label="2026-02-08 排班"] .bg-ok')).not.toBeNull();
    } finally { await page.cleanup(); }
  });

  it.each(["present", "absent"] as const)("手機可檢視已確認 %s 的日期，但明細與快速排班都不能移除", async (attendanceStatus) => {
    const page = await renderMobilePage({ ...data(), entries: [{ ...savedEntry, attendanceStatus }] });
    try {
      await page.clickDate("2026-02-06");
      expect(document.body.textContent).toContain("出勤已確認");
      expect(document.querySelector('[aria-label="移除 2026-02-06 小明 早班"]')).toBeNull();
      await openMobileQuick();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="2026-02-06 快速排班"]')!.disabled).toBe(true);
      expect(page.writes).toHaveLength(0);
    } finally { await page.cleanup(); }
  });

  it("手機 409 在快速排班內顯示錯誤，保留日期草稿並阻止重送", async () => {
    const page = await renderMobilePage(data(), 409);
    try {
      await page.clickDate("2026-02-07"); await openMobileQuick();
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="2026-02-07 快速排班"]')!.click());
      await page.click("儲存排班");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.textContent).toContain("同一據點排班重疊");
      expect(document.querySelector('[aria-label="2026-02-07 快速排班"]')!.getAttribute("aria-pressed")).toBe("true");
      await page.click("儲存排班"); expect(page.writes).toHaveLength(1);
    } finally { await page.cleanup(); }
  });

  it("手機鎖定月份只提供日期明細，不開放快速排班或移除", async () => {
    const page = await renderMobilePage(data(true));
    try {
      await page.clickDate("2026-02-06");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="移除 2026-02-06 小明 早班"]')!.disabled).toBe(true);
      expect([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "快速排班")?.disabled).toBe(true);
      expect(page.writes).toHaveLength(0);
    } finally { await page.cleanup(); }
  });

  it("手機快速排班會提示既有班別過期，不在未告知下重套歷史排班", async () => {
    const initial = data(); initial.shifts = initial.shifts.map((shift) => ({ ...shift, startSecond: shift.startSecond + 3600 }));
    const page = await renderMobilePage(initial);
    try {
      await page.clickDate("2026-02-07"); await openMobileQuick();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.textContent).toContain("有 1 筆班別設定已變更");
      expect(document.body.textContent).toContain("重新套用目前的日型、時間與需求人力");
      await page.click("返回月曆"); expect(page.writes[0]!.values.refreshIds).toEqual(["saved"]);
    } finally { await page.cleanup(); }
  });

  it("桌機保留目前人員已排天數與約定月休摘要", async () => {
    const initial = data(); initial.employees = initial.employees.map((person) => ({ ...person, monthlyRestDays: 8 }));
    const page = await renderPage(initial);
    try { expect(document.body.textContent).toContain("本據點已排 1 天・約定月休 8 天"); }
    finally { await page.cleanup(); }
  });

  it("再次點選已排日期只送移除 ID，新增後取消不產生變更", async () => {
    const page = await renderPage(data());
    try {
      await page.clickDate("2026-02-07"); await page.clickDate("2026-02-07");
      expect(document.body.textContent).not.toContain("尚未儲存");
      await page.clickDate("2026-02-06"); await page.save();
      expect(page.writes[0]!.values).toMatchObject({ entries: [], removedIds: ["saved"], refreshIds: [] });
    } finally { await page.cleanup(); }
  });

  it("API 失敗或背景版本改變時保留草稿，不採用新 revision 覆蓋他人", async () => {
    const page = await renderPage(data(), 409);
    try {
      await page.clickDate("2026-02-07"); await page.save();
      expect(document.body.textContent).toContain("同一據點排班重疊");
      expect(document.body.textContent).toContain("尚未儲存：新增 1 筆");
      expect(document.body.textContent).toContain("排班已被其他人修改，草稿仍保留");
      expect(document.querySelector('[aria-label="2026-02-07 排班"]')?.getAttribute("aria-pressed")).toBe("true");
      await page.save();
      expect(page.writes).toHaveLength(1);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await page.click("重新載入");
      expect(document.body.textContent).not.toContain("尚未儲存：新增 1 筆");
      await page.clickDate("2026-02-07"); await page.save();
      expect(page.writes[1]!.values.revision).toBe(3);
    } finally { await page.cleanup(); }
  });

  it("409 後重抓失敗仍保留草稿與重試入口，不重送舊 revision", async () => {
    const page = await renderPage(data(), 409, 1);
    try {
      await page.clickDate("2026-02-07"); await page.save();
      expect(document.body.textContent).toContain("最新班表暫時無法載入");
      expect(document.querySelector('[aria-label="2026-02-07 排班"]')?.getAttribute("aria-pressed")).toBe("true");
      await page.save(); expect(page.writes).toHaveLength(1);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await page.click("重新載入");
      expect((document.querySelector('[aria-label="2026-02-07 排班"]') as HTMLButtonElement).disabled).toBe(false);
      await page.clickDate("2026-02-07"); await page.save();
      expect(page.writes[1]!.values.revision).toBe(3);
    } finally { await page.cleanup(); }
  });

  it("返回、前進與程式導覽都先確認；取消不遺失草稿，確認才離頁", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const page = await renderPage(data());
    try {
      await page.clickDate("2026-02-07");
      for (const target of [-1, 1, "/profile"] as const) {
        await act(async () => { if (typeof target === "number") await page.router.navigate(target); else await page.router.navigate(target); });
        expect(page.router.state.location.pathname).toBe("/scheduling");
        expect(document.querySelector('[aria-label="2026-02-07 排班"]')?.getAttribute("aria-pressed")).toBe("true");
      }
      expect(confirm).toHaveBeenCalledTimes(3);
      confirm.mockReturnValue(true);
      await act(async () => { await page.router.navigate(-1); });
      expect(document.body.textContent).toContain("個人頁");
    } finally { await page.cleanup(); }
  });

  it("儲存期間拒絕離頁；儲存成功後解除阻擋", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const page = await renderPage(data());
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal("fetch", async (_path: RequestInfo | URL, init?: RequestInit) => init?.method === "PATCH" ? response : Response.json({ ...data(), version: { ...data().version!, revision: 3 } }));
    try {
      await page.clickDate("2026-02-07"); await page.save();
      await act(async () => { await page.router.navigate(-1); });
      expect(page.router.state.location.pathname).toBe("/scheduling");
      expect(confirm).not.toHaveBeenCalled();
      await act(async () => { finish(Response.json({ id: "version", revision: 3 })); await new Promise((resolve) => setTimeout(resolve, 10)); });
      await act(async () => { await page.router.navigate(-1); });
      expect(document.body.textContent).toContain("個人頁");
      expect(confirm).not.toHaveBeenCalled();
    } finally { await page.cleanup(); }
  });

  it.each(["present", "absent"] as const)("已確認出勤 %s 的日期不可取消，卡片不提供移除", async (attendanceStatus) => {
    const page = await renderPage({ ...data(), entries: [{ ...savedEntry, attendanceStatus }] });
    try {
      expect((document.querySelector('[aria-label="2026-02-06 排班"]') as HTMLButtonElement).disabled).toBe(true);
      expect(document.querySelector('[aria-label="移除 2026-02-06 小明 早班"]')).toBeNull();
      await page.clickDate("2026-02-06");
      expect(document.body.textContent).not.toContain("尚未儲存");
    } finally { await page.cleanup(); }
  });

  it("鎖定月份不可點日期或儲存", async () => {
    const page = await renderPage(data(true));
    try {
      expect((document.querySelector('[aria-label="2026-02-07 排班"]') as HTMLButtonElement).disabled).toBe(true);
      await page.clickDate("2026-02-07"); await page.save();
      expect(page.writes).toHaveLength(0);
    } finally { await page.cleanup(); }
  });
});

describe("共用排班差異", () => {
  it("忽略本機 ID 及陣列順序、保留封存列且不送整月", () => {
    const archived = { ...savedEntry, id: "archived", archivedAt: "2026-01-01" };
    expect(scheduleChanges([{ ...savedEntry, id: "local" }, archived], [archived, savedEntry])).toEqual({ entries: [], removedIds: [], refreshIds: [] });
    expect(scheduleChanges([], [archived, savedEntry], ["saved", "archived"])).toEqual({ entries: [], removedIds: ["saved"], refreshIds: [] });
  });
});
