// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClockCalendar, ClockCalendarDay } from "./api.js";
import { HrClockLogs } from "./Clock.js";

// 打卡紀錄頁不畫地圖；maplibre 在 jsdom 沒有 WebGL，連 import 都過不了。
vi.mock("maplibre-gl", () => ({ default: {} }));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

function day(values: Partial<ClockCalendarDay>): ClockCalendarDay {
  return { date: "2026-10-01", weekday: 4, specialKind: "none", specialScopeIds: [], status: "rest", eventCount: 0, workedMinutes: 0, firstEventAt: null, lastEventAt: null, anomaly: null, anomalyMessage: null, expectedStartAt: null, expectedEndAt: null, events: [], ...values };
}
const october: ClockCalendar = { year: 2026, month: 10, today: "2026-10-12", days: [
  day({ date: "2026-10-01", status: "missing", anomaly: "missing", anomalyMessage: "這天是預期出勤日，請確認是否忘記打卡。" }),
  day({ date: "2026-10-02", weekday: 5, status: "missing", anomaly: "missing" }),
] };
const november: ClockCalendar = { year: 2026, month: 11, today: "2026-10-12", days: [day({ date: "2026-11-02", weekday: 1, status: "future" })] };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });

async function renderPage() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T04:00:00Z"));
  notifyManager.setScheduler(queueMicrotask);
  let releaseNovember = () => {};
  vi.stubGlobal("fetch", async (path: RequestInfo | URL) => {
    if (String(path).includes("month=11")) await new Promise<void>((resolve) => { releaseNovember = resolve; });
    return Response.json(String(path).includes("month=11") ? november : october);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["hr", "/me/attendance-calendar?year=2026&month=10"], october);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><HrClockLogs /></MemoryRouter></QueryClientProvider>));
  return {
    container,
    summary: () => [...container.querySelectorAll(".hr-clock-history-summary strong")].map((node) => node.textContent),
    nextMonth: async () => { await act(async () => (container.querySelector('[aria-label="下個月"]') as HTMLButtonElement).click()); },
    finishLoading: async () => { await act(async () => { releaseNovember(); await new Promise((resolve) => setTimeout(resolve, 10)); }); },
    cleanup: async () => { await act(async () => root.unmount()); client.clear(); container.remove(); },
  };
}

describe("HR 前台打卡紀錄", () => {
  it("換月份載入中仍然畫出月份與統計，數字先顯示「—」", async () => {
    const page = await renderPage();
    try {
      expect(page.summary()).toEqual(["0 小時", "0 天", "2 天"]);
      await page.nextMonth();
      expect(page.container.querySelector(".hr-clock-history-toolbar strong")?.textContent).toBe("2026年11月");
      expect(page.summary()).toEqual(["—", "—", "—"]);
      expect(page.container.textContent).toContain("載入月度紀錄…");
      await page.finishLoading();
      expect(page.summary()).toEqual(["0 小時", "0 天", "0 天"]);
      expect(page.container.textContent).toContain("本月沒有需要顯示的紀錄");
    } finally { await page.cleanup(); }
  });

  it("缺卡日的異常說明只出現一次；後端沒給說明時仍說明這天沒有打卡", async () => {
    const page = await renderPage();
    try {
      const [withMessage, withoutMessage] = [...page.container.querySelectorAll(".hr-clock-history-day")];
      expect(withMessage!.textContent!.split("這天是預期出勤日，請確認是否忘記打卡。")).toHaveLength(2);
      expect(withoutMessage!.querySelector(".hr-clock-history-anomaly")?.textContent).toBe("這天尚未有打卡紀錄。");
    } finally { await page.cleanup(); }
  });
});
