// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { fetchSession } from "./auth/session.js";

const liff = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("./auth/liff.js", () => ({ isLiffConfigured: () => true, isLiffClient: () => Boolean(liff.token), getLiffIdToken: () => liff.token }));
vi.mock("./routes/hr/Clock.js", () => ({ HrClock: () => <p>打卡入口</p>, HrClockCalendar: () => <p>出勤日曆入口</p>, HrClockLogs: () => <p>打卡紀錄入口</p> }));
vi.mock("./routes/hr/Forms.js", () => ({ HrForms: () => <p>表單申請入口</p>, HrClockCorrectionForm: () => null, HrLeaveForm: () => null, HrOvertimeForm: () => null }));
vi.mock("./routes/hr/Payroll.js", () => ({ HrPayrollHistory: () => <p>薪資袋入口</p>, HrPayslipDetail: () => null }));
vi.mock("./routes/hr/Notifications.js", () => ({ HrNotifications: () => <p>通知入口</p> }));
vi.mock("./routes/Profile.js", () => ({ HrProfile: () => <p>個人中心入口</p> }));
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
let replaceRequired: boolean;
let lineAuthenticated: boolean;
let sessionReadDelay: Promise<void> | null;
let intentFailure: "network" | "server" | null;
let signOutFailure: boolean;
let platformOnly: boolean;
let expired: boolean;
let sessionAuthorized: boolean;
let requested: string[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  intentPending = false;
  linked = false;
  replaceRequired = false;
  lineAuthenticated = false;
  sessionReadDelay = null;
  intentFailure = null;
  signOutFailure = false;
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
    if (path.endsWith("/me/liff-session")) {
      if (linked) lineAuthenticated = true;
      return Response.json({ linked });
    }
    if (path.endsWith("/me/session")) {
      if (lineAuthenticated && sessionReadDelay) await sessionReadDelay;
      if (!sessionAuthorized) return Response.json({ error: "請先登入。" }, { status: 401 });
      return Response.json({ ...user, deviceRemembered: !platformOnly || lineAuthenticated, lineLiffAuthenticated: lineAuthenticated });
    }
    if (path.endsWith("/liff/link")) {
      if (!platformOnly && !liff.token) return Response.json({ error: "請先登入。" }, { status: 401 });
      if (init?.method !== "POST" && intentFailure === "network") throw new Error("連不上伺服器");
      if (init?.method !== "POST" && intentFailure === "server") return Response.json({ error: "意圖查詢暫時失敗" }, { status: 503 });
      if (init?.method === "POST") {
        if (expired) {
          intentPending = false;
          return Response.json({ error: "LINE 綁定驗證已逾時，請重新從 LINE 開啟打卡頁。" }, { status: 400 });
        }
        linked = true;
        lineAuthenticated = true;
        intentPending = false;
        return Response.json({ linked: true });
      }
      return Response.json({ linked, pending: intentPending, replaceRequired });
    }
    if (path.endsWith("/me/device")) return signOutFailure && init?.method === "DELETE"
      ? Response.json({ error: "登出暫時失敗" }, { status: 503 }) : Response.json({ ok: true });
    throw new Error(`未預期請求：${path}`);
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  liff.token = null;
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("fetch", async () => Response.json({ ...user, lineLiffAuthenticated: true }));
  await fetchSession();
  vi.unstubAllGlobals();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});

async function renderApp(path = "/clock") {
  window.history.replaceState({}, "", path);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>));
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
  it("工作分類沿用本人登入 gate，連結排班與既有申請路徑", async () => {
    await renderApp("/work"); await expectText("排班與表單申請集中在這裡");
    expect(container.querySelector('a[href="/scheduling"]')?.textContent).toContain("排班");
    const forms = container.querySelector<HTMLAnchorElement>('a[href="/forms"]')!;
    expect(forms.textContent).toContain("表單申請");
    await act(async () => forms.click()); await expectText("表單申請入口");
  });

  it("主動登出的 LINE 登入頁不 bootstrap 或導回打卡，並提供明確重新登入入口", async () => {
    liff.token = "line-id-token";
    linked = true;
    lineAuthenticated = true;
    await renderApp("/login?signedOut=1");
    await expectText("使用 LINE 重新登入");
    expect(container.textContent).toContain("LINE 綁定仍保留");
    expect([...container.querySelectorAll("a")].find((link) => link.textContent === "使用 LINE 重新登入")?.getAttribute("href")).toBe("/");
    expect(container.textContent).not.toContain("打卡入口");
    expect(requested).toEqual([]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["session"] }); });
    expect(requested).toEqual([]);
    expect(container.textContent).toContain("使用 LINE 重新登入");
  });

  it.each(["/login?signedOut=1", "https://other.example.test/", "//other.example.test/"])("明確 LINE 重新登入不接受返回登入頁或外站的 returnTo：%s", async (returnTo) => {
    liff.token = "line-id-token";
    await renderApp(`/login?signedOut=1&returnTo=${encodeURIComponent(returnTo)}`);
    await expectText("使用 LINE 重新登入");
    expect([...container.querySelectorAll("a")].find((link) => link.textContent === "使用 LINE 重新登入")?.getAttribute("href")).toBe("/");
    expect(requested).toEqual([]);
  });

  it("一般瀏覽器主動登出保留帳號密碼與 Google，不顯示不能使用的 LINE 入口", async () => {
    await renderApp("/login?signedOut=1");
    await expectText("使用 Google 帳號登入");
    expect(container.textContent).toContain("或使用帳號密碼登入");
    expect(container.textContent).not.toContain("使用 LINE 重新登入");
    expect(requested).toEqual([]);
  });

  it("綁定頁登出失敗保留帳號與錯誤，按鈕可再次操作", async () => {
    platformOnly = true;
    intentPending = true;
    await renderApp();
    await expectText("綁定 LINE 打卡");
    signOutFailure = true;
    await clickButton("不是這個帳號？登出後切換");
    await expectText("登出暫時失敗");
    expect(client.getQueryData(["session"])).toMatchObject({ id: "employee", lineLinkRequired: true });
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "不是這個帳號？登出後切換")?.disabled).toBe(false);
  });
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

  it.each(["network", "server"] as const)("OAuth 意圖探測 %s 失敗時不記住一般裝置，恢復後仍可確認綁定", async (failure) => {
    platformOnly = true;
    intentPending = true;
    intentFailure = failure;
    await renderApp();
    await expectText("重新嘗試");
    expect(container.textContent).not.toContain("打卡入口");
    expect(requested).not.toContain("POST /api/hr/me/device");
    intentFailure = null;
    await clickButton("重新嘗試");
    await expectText("綁定 LINE 打卡");
    expect(requested).not.toContain("POST /api/hr/me/device");
    await clickButton("確認並綁定這個帳號");
    await expectText("打卡入口");
  });

  it("OAuth 返回已存在相同綁定但尚無 LINE session 時，確認成功交付 session 後退出 gate", async () => {
    platformOnly = true;
    intentPending = true;
    linked = true;
    await renderApp();
    await expectText("綁定 LINE 打卡");
    expect(client.getQueryData(["session"])).toMatchObject({ lineLiffAuthenticated: false, lineLinkRequired: true });
    expect(container.textContent).not.toContain("已綁定另一個 LINE 帳號");
    await clickButton("確認並綁定這個帳號");
    await expectText("打卡入口");
    expect(client.getQueryData(["session"])).toMatchObject({ lineLiffAuthenticated: true, lineLinkRequired: false });
  });

  it("只有伺服器確認為不同 LINE 身分時才提示替換", async () => {
    platformOnly = true;
    intentPending = true;
    linked = true;
    replaceRequired = true;
    await renderApp();
    await expectText("已綁定另一個 LINE 帳號");
    await clickButton("解除舊綁定並改綁目前 LINE");
    await expectText("打卡入口");
  });

  it("綁定成功但 session 尚未讀回時保持處理中，不閃逾時或改綁警告", async () => {
    platformOnly = true;
    intentPending = true;
    await renderApp();
    await expectText("綁定 LINE 打卡");
    let resume!: () => void;
    sessionReadDelay = new Promise<void>((resolve) => { resume = resolve; });
    try {
      await clickButton("確認並綁定這個帳號");
      await expectText("驗證並綁定中…");
      const submittedAt = requested.indexOf("POST /api/hr/liff/link");
      expect(requested.slice(submittedAt + 1)).not.toContain("GET /api/hr/liff/link");
      // 模擬背景重抓已清除 intent 的綁定狀態，也不能在成功轉場中顯示錯誤。
      await act(async () => { await client.invalidateQueries({ queryKey: ["hr"] }); });
      expect(container.textContent).not.toContain("驗證已逾時");
      expect(container.textContent).not.toContain("已綁定另一個 LINE 帳號");
      expect([...container.querySelectorAll("button")].find((button) => button.textContent === "驗證並綁定中…")?.disabled).toBe(true);
    } finally {
      await act(async () => { resume(); });
    }
    await expectText("打卡入口");
    expect(container.textContent).not.toContain("綁定 LINE 打卡");
  });

  it.each([
    ["/clock/calendar", "出勤日曆入口"], ["/clock/logs", "打卡紀錄入口"], ["/forms", "表單申請入口"],
    ["/payroll", "薪資袋入口"], ["/notifications", "通知入口"], ["/profile", "個人中心入口"],
  ])("LINE 登入可開啟 %s，不被導回打卡", async (path, label) => {
    lineAuthenticated = true;
    await renderApp(path);
    await expectText(label);
    expect(container.textContent).not.toContain("打卡入口");
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
