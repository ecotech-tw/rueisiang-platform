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
  const router = createMemoryRouter([{ path: "*", element: <Routes><Route path="/scheduling" element={<HrScheduling />} /><Route path="/profile" element={<p>個人頁</p>} /></Routes> }], { initialEntries: ["/profile", "/scheduling", "/profile"], initialIndex: 1 });
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  return { client, writes, router, click: async (label: string) => { await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); }); }, clickDate: async (date: string) => { await act(async () => (container.querySelector(`[aria-label="${date} 排班"]`) as HTMLButtonElement).click()); }, save: async () => { await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "儲存")!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); }); }, cleanup: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
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
      expect(document.body.textContent).toContain("排班已儲存並生效，不需送審");
    } finally { await page.cleanup(); }
  });

  it("再次點選已排日期只送移除 ID，新增後取消不產生變更", async () => {
    const page = await renderPage(data());
    try {
      await page.clickDate("2026-02-07"); await page.clickDate("2026-02-07");
      expect(document.body.textContent).toContain("沒有未儲存變更");
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
      expect(document.body.textContent).toContain("沒有未儲存變更");
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
