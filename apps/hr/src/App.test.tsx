// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { fetchSession } from "./auth/session.js";

const liff = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("./auth/liff.js", () => ({ isLiffConfigured: () => true, getLiffIdToken: () => liff.token }));
vi.mock("./routes/hr/Clock.js", () => ({ HrClock: () => <p>打卡入口</p>, HrClockCalendar: () => null, HrClockLogs: () => null }));
vi.mock("./routes/hr/HrLayout.js", async () => {
  const { Outlet } = await import("react-router");
  return { HrLayout: () => <Outlet /> };
});

const user = {
  id: "employee", email: "employee@example.test", name: "測試員工", pictureUrl: "", isEmployee: true,
  deviceRemembered: true, lineLiffAuthenticated: false,
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let intentPending: boolean;
let linked: boolean;
let platformOnly: boolean;
let expired: boolean;
let sessionAuthorized: boolean;
let requested: string[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  intentPending = false;
  linked = false;
  platformOnly = false;
  expired = false;
  sessionAuthorized = true;
  requested = [];
  liff.token = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://hr.example.test").pathname;
    requested.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/me/liff-session")) return Response.json({ linked });
    if (path.endsWith("/me/session")) {
      if (!sessionAuthorized) return Response.json({ error: "請先登入。" }, { status: 401 });
      return Response.json({ ...user, deviceRemembered: !platformOnly || linked, lineLiffAuthenticated: linked });
    }
    if (path.endsWith("/liff/link")) {
      if (!platformOnly && !liff.token) return Response.json({ error: "請先登入。" }, { status: 401 });
      if (init?.method === "POST") {
        if (expired) {
          intentPending = false;
          return Response.json({ error: "LINE 綁定驗證已逾時，請重新從 LINE 開啟打卡頁。" }, { status: 400 });
        }
        linked = true;
        intentPending = false;
        return Response.json({ linked: true });
      }
      return Response.json({ linked: false, pending: intentPending });
    }
    if (path.endsWith("/me/device")) return Response.json({ ok: true });
    throw new Error(`未預期請求：${path}`);
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  liff.token = null;
  vi.stubGlobal("fetch", async () => Response.json({ ...user, lineLiffAuthenticated: true }));
  await fetchSession();
  vi.unstubAllGlobals();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

async function renderApp() {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/clock"]}><App /></MemoryRouter></QueryClientProvider>));
}
async function expectText(text: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.textContent).toContain(text);
  });
}
async function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("LIFF 與一般 HR 登入流程", () => {
  it("啟用 LIFF 後只有一般裝置 cookie 仍能進打卡，不查要求平台登入的綁定 API", async () => {
    await renderApp();
    await expectText("打卡入口");
    expect(requested).not.toContain("GET /api/hr/liff/link");
  });

  it("一般平台登入沒有 LINE 意圖時不進入綁定 gate，仍補發一般裝置", async () => {
    platformOnly = true;
    await renderApp();
    await expectText("打卡入口");
    expect(requested).toContain("POST /api/hr/me/device");
  });

  it("LINE 未綁定時先要求平台登入，登入後才能確認綁定", async () => {
    liff.token = "line-id-token";
    sessionAuthorized = false;
    expect(await fetchSession()).toBeNull();
    sessionAuthorized = true;
    intentPending = true;
    await renderApp();
    await expectText("綁定 LINE 打卡");
    expect(container.textContent).not.toContain("打卡入口");
    await clickButton("確認並綁定這個帳號");
    await expectText("打卡入口");
    expect(client.getQueryData(["session"])).toMatchObject({ lineLiffAuthenticated: true, lineLinkRequired: false });
  });

  it("Google OAuth 回到一般瀏覽器時仍讀取短效意圖並等待確認，不先發一般裝置", async () => {
    platformOnly = true;
    intentPending = true;
    await renderApp();
    await expectText("綁定 LINE 打卡");
    expect(requested).not.toContain("POST /api/hr/me/device");
    await clickButton("確認並綁定這個帳號");
    await expectText("打卡入口");
  });

  it("綁定逾時 POST 400 後的 query refetch 不卸載綁定頁，保留錯誤與恢復入口", async () => {
    platformOnly = true;
    intentPending = true;
    await renderApp();
    await expectText("綁定 LINE 打卡");
    expired = true;
    await clickButton("確認並綁定這個帳號");
    await expectText("重新載入驗證");
    expect(container.textContent).toContain("LINE 綁定驗證已逾時");
    expect(container.textContent).toContain("綁定 LINE 打卡");
    expect(container.textContent).not.toContain("打卡入口");
    await act(async () => { await client.invalidateQueries({ queryKey: ["session"] }); });
    await expectText("重新載入驗證");
    expect(requested).not.toContain("POST /api/hr/me/device");
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "確認並綁定這個帳號");
    expect(confirm?.disabled).toBe(true);
  });
});
