import { describe, expect, it, vi } from "vitest";
import { createAuthRedirectFetch, type AuthRedirectLocation } from "./fetch-redirect.js";

function location(pathname = "/hr/leave", search = "?month=2026-06", hash = "#pending"): AuthRedirectLocation {
  return { origin: "https://platform.example", pathname, search, hash, assign: vi.fn() };
}

describe("createAuthRedirectFetch", () => {
  it("401 受保護 API 導向登入並保留完整 returnTo", async () => {
    const current = location();
    const request = createAuthRedirectFetch(async () => new Response(null, { status: 401 }), current);

    await request("/api/hr/leave");

    expect(current.assign).toHaveBeenCalledWith("/login?returnTo=%2Fhr%2Fleave%3Fmonth%3D2026-06%23pending");
  });

  it("不把 403 權限錯誤當成未登入", async () => {
    const current = location();
    const request = createAuthRedirectFetch(async () => new Response(null, { status: 403 }), current);

    await request("/api/hr/leave");

    expect(current.assign).not.toHaveBeenCalled();
  });

  it.each(["/api/auth/password", "/api/auth/invite/token", "/api/auth/logout"])("保留公開認證流程的 401：%s", async (path) => {
    const current = location();
    const request = createAuthRedirectFetch(async () => new Response(null, { status: 401 }), current);

    await request(path);

    expect(current.assign).not.toHaveBeenCalled();
  });

  it("登入頁不因 session 查詢的 401 形成導向循環", async () => {
    const current = location("/login", "?returnTo=%2Fhr%2Fleave", "");
    const request = createAuthRedirectFetch(async () => new Response(null, { status: 401 }), current);

    await request("/api/auth/me");

    expect(current.assign).not.toHaveBeenCalled();
  });

  it("只攔截同源 API，不攔截外站 401", async () => {
    const current = location();
    const request = createAuthRedirectFetch(async () => new Response(null, { status: 401 }), current);

    await request("https://other.example/api/hr/leave");

    expect(current.assign).not.toHaveBeenCalled();
  });
  it("接受 HR 設定的跨來源 API base URL", async () => {
    const current = location();
    const request = createAuthRedirectFetch(async () => new Response(null, { status: 401 }), current, "https://api.example.test/api");

    await request("https://api.example.test/api/hr/leave");

    expect(current.assign).toHaveBeenCalledWith("/login?returnTo=%2Fhr%2Fleave%3Fmonth%3D2026-06%23pending");
  });
});
