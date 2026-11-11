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
  const calendar = Array.from({ length: 28 }, (_, index) => {
    const day = index + 1;
    const date = `2026-02-${String(day).padStart(2, "0")}`;
    return { date, dayType: "weekday" as const, name: "" };
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    periodKey: "2026-02",
    scopes: [{ id: "store-a", name: "台北店" }, { id: "store-b", name: "桃園店" }],
    calendar,
    scheduleManagers: [{ scopeId: "store-a", name: "管理者" }, { scopeId: "store-b", name: "管理者" }],
    entries: [
      { workDate: "2026-02-05", scopeId: "store-a", scopeName: "台北店", personKind: "employee", personName: "本人", shiftName: "早班", startsAt: "2026-02-05 09:00:00", endsAt: "2026-02-05 18:00:00", isMine: true },
      { workDate: "2026-02-05", scopeId: "store-a", scopeName: "台北店", personKind: "employee", personName: "同事", shiftName: "晚班", startsAt: "2026-02-05 13:00:00", endsAt: "2026-02-05 21:00:00", isMine: false },
      { workDate: "2026-02-10", scopeId: "store-b", scopeName: "桃園店", personKind: "employee", personName: "本人", shiftName: "晚班", startsAt: "2026-02-10 13:00:00", endsAt: "2026-02-10 21:00:00", isMine: true },
    ],
  })));
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><HrMySchedule /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("本月 2 班")); });
    expect(container.textContent).toContain("台北店・早班");
    expect(container.textContent).toContain("桃園店・晚班");
    expect(container.textContent).toContain("全部據點");
    expect([...container.querySelectorAll("button")].some((button) => /儲存|鎖定|編輯/.test(button.textContent ?? button.getAttribute("aria-label") ?? ""))).toBe(false);
    await act(async () => root.unmount());
  } finally {
    client.clear();
    container.remove();
  }
});
