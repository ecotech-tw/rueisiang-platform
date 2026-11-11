// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { HrMySchedule } from "./MySchedule.js";

afterEach(() => vi.unstubAllGlobals());

it("顯示跨據點本人班表摘要與日期值班明細，且只有唯讀操作", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const month = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const periodKey = `${month.find((part) => part.type === "year")?.value}-${month.find((part) => part.type === "month")?.value}`;
  const daysInMonth = new Date(Date.UTC(Number(periodKey.slice(0, 4)), Number(periodKey.slice(5)) , 0)).getUTCDate();
  const dateFor = (day: number) => `${periodKey}-${String(day).padStart(2, "0")}`;
  const calendar = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = dateFor(day);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { date, dayType: weekday === 0 || weekday === 6 ? "weekend" as const : "weekday" as const, name: "" };
  });
  const weekendDate = calendar.find((day) => day.dayType === "weekend")!.date;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    periodKey,
    attendanceMode: "scheduled",
    monthlyRestDays: 10,
    scopes: [{ id: "store-a", name: "台北店" }, { id: "store-b", name: "桃園店" }],
    calendar,
    scheduleManagers: [{ scopeId: "store-a", name: "管理者" }, { scopeId: "store-b", name: "管理者" }],
    entries: [
      { workDate: dateFor(5), scopeId: "store-a", scopeName: "台北店", personKind: "employee", personName: "本人", shiftName: "早班", startsAt: `${dateFor(5)} 09:00:00`, endsAt: `${dateFor(5)} 18:00:00`, isMine: true },
      { workDate: dateFor(5), scopeId: "store-a", scopeName: "台北店", personKind: "employee", personName: "同事", shiftName: "晚班", startsAt: `${dateFor(5)} 13:00:00`, endsAt: `${dateFor(5)} 21:00:00`, isMine: false },
      { workDate: dateFor(10), scopeId: "store-b", scopeName: "桃園店", personKind: "employee", personName: "本人", shiftName: "晚班", startsAt: `${dateFor(10)} 13:00:00`, endsAt: `${dateFor(10)} 21:00:00`, isMine: true },
    ],
  })));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><HrMySchedule /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("月曆檢視")); });
    expect(container.textContent).not.toContain("本人班表");
    const summaryButton = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "班表摘要");
    expect(summaryButton).toBeDefined();
    await act(async () => summaryButton?.click());
    expect(container.textContent).toContain("本月 2 班・約定月休 10 天");
    expect(container.textContent).not.toContain("點選日期查看當日值班人員");
    expect(container.querySelector("ul")?.className).toContain("overflow-y-auto");
    expect(container.textContent).toContain("台北店・早班");
    expect(container.textContent).toContain("桃園店・晚班");
    expect(container.textContent).toContain("全部據點");
    const calendarButton = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "月曆檢視");
    await act(async () => calendarButton?.click());
    const dateButton = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith(dateFor(5)));
    expect(dateButton?.className).toContain("bg-brand-soft");
    expect(dateButton?.parentElement?.className).toContain("border-t");
    const weekendButton = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith(weekendDate));
    expect(weekendButton?.className).toContain("bg-canvas");
    expect(weekendButton?.className).toContain("text-brand-dark");
    await act(async () => dateButton?.click());
    expect(document.body.textContent).toContain("本人（本人）");
    expect(document.body.textContent).toContain("同事");
    expect([...container.querySelectorAll("button")].some((button) => /儲存|鎖定|編輯/.test(button.textContent ?? button.getAttribute("aria-label") ?? ""))).toBe(false);
    await act(async () => root.unmount());
  } finally {
    client.clear();
    container.remove();
  }
});
