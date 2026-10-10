import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSession, useSignOut } from "./session.js";

const state = vi.hoisted(() => ({ clear: vi.fn(), token: "line-id-token" as string | null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: () => ({ clear: state.clear }) }));
vi.mock("./liff.js", () => ({ getLiffIdToken: () => state.token, isLiffConfigured: () => true }));
const location = {
  pathname: "/clock", search: "",
  assign: vi.fn((path: string) => {
    const url = new URL(path, "https://hr.example.test");
    location.pathname = url.pathname;
    location.search = url.search;
  }),
};

beforeEach(() => {
  state.clear.mockClear();
  state.token = "line-id-token";
  location.pathname = "/clock";
  location.search = "";
  location.assign.mockClear();
  vi.stubGlobal("window", { location });
});
afterEach(async () => {
  location.pathname = "/login";
  location.search = "?signedOut=1";
  await fetchSession();
  vi.unstubAllGlobals();
});

describe("主動登出與 LINE 自動登入", () => {
  it("撤銷成功後停留登入頁，重新整理／重抓也不重新發證", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await useSignOut()();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/hr/me/device"), { method: "DELETE", credentials: "include" });
    expect(state.clear).toHaveBeenCalledOnce();
    expect(location.assign).toHaveBeenCalledWith("/login?signedOut=1");
    expect(await fetchSession()).toBeNull();
    expect(await fetchSession()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["明確重新登入", "重新從 LINE 開啟"])("%s 的正常入口仍向 API 驗證 LINE 身分與讀回 session", async () => {
    location.pathname = "/login";
    location.search = "?signedOut=1";
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/me/liff-session")
      ? Response.json({ linked: true })
      : Response.json({ id: "employee", deviceRemembered: true, lineLiffAuthenticated: true }));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchSession()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    location.assign("/");
    expect(await fetchSession()).toMatchObject({ id: "employee", lineLiffAuthenticated: true, lineLinkRequired: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toContain("/hr/me/liff-session");
    expect(fetch.mock.calls[1]?.[0]).toContain("/hr/me/session");
  });

  it("signedOut 參數不會停用非登入頁的 LINE 自動登入", async () => {
    location.search = "?signedOut=1";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input).endsWith("/me/liff-session")
      ? Response.json({ linked: true }) : Response.json({ id: "employee", deviceRemembered: true, lineLiffAuthenticated: true }));
    expect(await fetchSession()).toMatchObject({ id: "employee", lineLiffAuthenticated: true });
  });

  it("一般瀏覽器登出後仍可用正常平台登入入口", async () => {
    state.token = null;
    vi.stubGlobal("fetch", async () => Response.json({ ok: true }));
    await useSignOut()();
    expect(await fetchSession()).toBeNull();
    location.assign("/");
    vi.stubGlobal("fetch", async () => Response.json({ id: "employee", deviceRemembered: true, lineLiffAuthenticated: false }));
    expect(await fetchSession()).toMatchObject({ id: "employee", lineLiffAuthenticated: false, lineLinkRequired: false });
  });

  it.each(["network", "server"] as const)("登出 %s 失敗不清除快取或假裝已登出", async (failure) => {
    vi.stubGlobal("fetch", async () => {
      if (failure === "network") throw new Error("網路中斷");
      return Response.json({ error: "登出暫時失敗" }, { status: 503 });
    });
    await expect(useSignOut()()).rejects.toThrow();
    expect(state.clear).not.toHaveBeenCalled();
    expect(location.assign).not.toHaveBeenCalled();
  });

  it("憑證已失效的 401 視為已登出，仍阻止登入頁自動發證", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "請先登入。" }, { status: 401 }));
    await useSignOut()();
    expect(location.assign).toHaveBeenCalledWith("/login?signedOut=1");
    expect(await fetchSession()).toBeNull();
  });
});
