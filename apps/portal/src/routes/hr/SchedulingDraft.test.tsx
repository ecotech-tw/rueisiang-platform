// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HrScheduleResponse } from "./api.js";
import { HrScheduling } from "./Scheduling.js";

vi.mock("../../auth/session.js", () => ({ useSession: () => ({ permissions: new Set(["hr:schedule:read", "hr:schedule:write"]) }) }));
vi.mock("../../shell/Toast.js", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../shell/UnsavedChanges.js", async () => { const { Link } = await import("react-router"); return { useConfirmLeave: () => async () => true, useUnsavedChanges: vi.fn(), GuardedNavLink: Link }; });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });
function data(revision = 2): HrScheduleResponse {
  return { periodKey: "2026-02", period: { start: "2026-02-01", end: "2026-03-01" }, version: { id: "version", revision, status: "published", locked: false, lockedAt: null }, scopes: [{ id: "store", name: "門市" }], calendar: Array.from({ length: 28 }, (_, index) => ({ date: `2026-02-${String(index + 1).padStart(2, "0")}`, dayType: "weekday", name: "", specialKind: "none", specialScopeIds: [], overridden: false })), employees: [{ employmentId: "employee", userId: "user", employeeNumber: "E1", name: "小明" }], workers: [], entries: [], shifts: [{ versionId: "shift", templateId: "early", scopeId: "store", name: "早班", dayType: "weekday", revision: 1, startSecond: 32400, endSecond: 64800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 }] };
}

async function renderPage() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.setSystemTime(new Date("2026-02-01T00:00:00Z")); notifyManager.setScheduler(queueMicrotask);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["hr", "/schedules?periodKey=2026-02"], data());
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_path: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return Response.json({ id: "version", revision: 3 }); }
    return Response.json(data(3));
  });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const click = async (label: string) => { await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><HrScheduling /></QueryClientProvider></MemoryRouter>));
  await click("快速排班");
  const dateButton = () => [...container.querySelectorAll<HTMLButtonElement>(".hr-quick-day")].find((button) => button.textContent === "7")!;
  await act(async () => dateButton().click());
  return { client, writes, click, dateButton, cleanup: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}

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
