// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HrWork } from "./Work.js";

afterEach(() => vi.unstubAllGlobals());

async function render(response: Response) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async () => response));
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><HrWork /></MemoryRouter></QueryClientProvider>));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

async function waitForQuery(callback: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    callback();
  });
}

describe("HR 工作分類", () => {
  it("沒有負責的排班據點時不顯示排班入口，仍保留表單申請", async () => {
    const page = await render(Response.json({ scopes: [] }));
    try {
      await waitForQuery(() => expect(page.container.querySelector('a[href="/scheduling"]')).toBeNull());
      expect(page.container.querySelector('a[href="/forms"]')?.textContent).toContain("表單申請");
    } finally { await page.cleanup(); }
  });

  it("有負責的排班據點時顯示排班入口", async () => {
    const page = await render(Response.json({ scopes: [{ id: "store", name: "門市" }] }));
    try {
      await waitForQuery(() => expect(page.container.querySelector('a[href="/scheduling"]')?.textContent).toContain("排班"));
      expect(page.container.querySelector('a[href="/forms"]')).not.toBeNull();
    } finally { await page.cleanup(); }
  });

  it("查詢負責據點失敗時不顯示排班入口並說明載入錯誤", async () => {
    const page = await render(Response.json({ error: "暫時無法載入" }, { status: 503 }));
    try {
      await waitForQuery(() => expect(page.container.textContent).toContain("排班據點載入失敗，請重新整理後再試。"));
      expect(page.container.querySelector('a[href="/scheduling"]')).toBeNull();
      expect(page.container.querySelector('a[href="/forms"]')).not.toBeNull();
    } finally { await page.cleanup(); }
  });
});
