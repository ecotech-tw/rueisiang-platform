// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HrLayout } from "./HrLayout.js";

afterEach(() => { vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });

describe("HR 手機導覽", () => {
  it.each(["/clock", "/forms"])("LINE 登入在 %s 仍顯示完整五項手機導覽與通知數", async (path) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    notifyManager.setScheduler(queueMicrotask);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["session"], { id: "employee", lineLiffAuthenticated: true });
    const fetch = vi.fn(async () => Response.json({ notifications: [], unreadCount: 3 }));
    vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes>
        <Route element={<HrLayout />}><Route path="*" element={<p>本人功能</p>} /></Route>
      </Routes></MemoryRouter></QueryClientProvider>));
      await vi.waitFor(async () => {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
        const nav = container.querySelector(".hr-personal-bottom-nav");
        expect([...nav!.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/forms", "/payroll", "/clock", "/notifications", "/profile"]);
        expect(nav?.textContent).toContain("表單申請");
        expect(nav?.textContent).toContain("薪資袋");
        expect(nav?.textContent).toContain("個人中心");
        expect(nav?.querySelector(".hr-personal-nav-badge")?.textContent).toBe("3");
      });
      expect(fetch.mock.calls).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
});
