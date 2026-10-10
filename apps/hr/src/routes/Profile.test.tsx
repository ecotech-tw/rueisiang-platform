// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HrProfile } from "./Profile.js";

afterEach(() => { vi.unstubAllGlobals(); notifyManager.setScheduler((callback) => setTimeout(callback, 0)); });

describe("個人中心登出", () => {
  it("撤銷失敗保留對話框、登入快取及錯誤，允許重試而不假裝登出成功", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    notifyManager.setScheduler(queueMicrotask);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["session"], { id: "employee", lineLiffAuthenticated: true });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "DELETE"
      ? Response.json({ error: "登出暫時失敗" }, { status: 503 }) : Response.json({ profile: null }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><HrProfile /></QueryClientProvider>));
      const click = async (label: string) => {
        const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
        expect(button).toBeDefined();
        await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
      };
      await click("登出此裝置");
      await click("確認登出");
      await vi.waitFor(() => expect(document.body.textContent).toContain("登出暫時失敗"));
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      expect(client.getQueryData(["session"])).toMatchObject({ id: "employee" });
      expect([...document.querySelectorAll("button")].find((button) => button.textContent === "確認登出")?.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
});
