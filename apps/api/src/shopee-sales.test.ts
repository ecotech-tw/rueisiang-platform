import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, getShopeeSalesSettings, listShopeeSalesRuns, syncSystemRoles } from "@rueisiang/db";
import { reportRunScopes, reportRuns, rolePermissionGrants, roles, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "test-secret";
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

function stubGithub() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    return new Response(null, { status: 204 });
  });
  return calls;
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, requestPath: string, init: RequestInit = {}) {
  const token = await signSession(newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }), SECRET);
  const headers = new Headers(init.headers);
  headers.set("Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}`);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return app.fetch(new Request(`https://platform.rueisiang.com${requestPath}`, { ...init, headers }), env as never);
}

beforeEach(async () => {
  d1 = createLocalD1();
  uploads = createLocalR2(fs.mkdtempSync(path.join(os.tmpdir(), "shopee-sales-test-")));
  env = {
    DB: d1,
    UPLOADS: uploads,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_TOKEN: "gh-token",
    SHOPEE_GITHUB_REPO: "ecotech-tw/rueisiang-platform",
    SHOPEE_WORKFLOW_FILE: "shopee-sales-report.yml",
    SHOPEE_GITHUB_REF: "main",
    SHOPEE_SOURCE_BASE_URL: "https://platform.rueisiang.com",
  };
  await syncSystemRoles(db());
});

afterEach(() => vi.unstubAllGlobals());

describe("蝦皮銷售報表", () => {
  it("有執行權限的人可以讀到預設區間與空設定", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-15T12:00:00.000Z") });
    try {
      const id = await seedUser("manager@ecotech.tw", "role-manager");
      const response = await as(id, "manager@ecotech.tw", "/api/tools/shopee-sales/state");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ start: "2026-07-01", end: "2026-07-31", settings: { driveFolderUrl: "" }, configured: true, latestRequestId: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("沒有 Drive 連結時不會觸發 GitHub", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const form = new FormData();
    form.append("file", new File(["xlsx"], "report.xlsx"));
    form.append("password", "042213");
    const response = await as(id, "manager@ecotech.tw", "/api/tools/shopee-sales/upload", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("管理者設定 Drive 後，執行者可直接上傳報表並觸發 GitHub", async () => {
    const calls = stubGithub();
    const admin = await seedUser("eli@ecotech.tw", "role-admin");
    // Drive 資料夾改在通路管理設定；這裡就是實際的操作路徑。
    const shopeeScopeId = (await getShopeeSalesSettings(db())).id;
    const saved = await as(admin, "eli@ecotech.tw", `/api/tools/scopes/${encodeURIComponent(shopeeScopeId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "蝦皮", sourceType: "shopee",
        driveFolderUrl: "https://drive.google.com/drive/folders/folder123", driveFolderName: "蝦皮",
      }),
    });
    expect(saved.status).toBe(200);

    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const form = new FormData();
    form.append("file", new File(["xlsx"], "Order.completed.20250201_20250228.xlsx"));
    form.append("password", "042213");
    const response = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/upload", { method: "POST", body: form });
    expect(response.status).toBe(202);
    expect(calls[0]?.url).toContain("actions/workflows/shopee-sales-report.yml/dispatches");
    const inputs = (calls[0]?.body.inputs ?? {}) as Record<string, string>;
    expect(inputs.drive_folder_url).toBe("https://drive.google.com/drive/folders/folder123");
    expect(inputs.start).toBe("2025-02-01");
    expect(inputs.end).toBe("2025-02-28");
    const sourceUrl = inputs.source_url!;
    expect(sourceUrl).toContain("/api/internal/shopee-sales/source/");
    expect(await listShopeeSalesRuns(db())).toMatchObject([{ driveFolderUrl: "https://drive.google.com/drive/folders/folder123" }]);
    expect(await db().select({ sourceType: reportRuns.sourceType, importsSales: reportRuns.importsSales, importsPayout: reportRuns.importsPayout }).from(reportRuns)).toEqual([
      { sourceType: "shopee", importsSales: 1, importsPayout: 1 },
    ]);
    expect(await db().select({ id: scopes.id, driveFolderUrl: scopes.driveFolderUrl }).from(scopes).where(eq(scopes.sourceType, "shopee"))).toEqual([
      { id: shopeeScopeId, driveFolderUrl: "https://drive.google.com/drive/folders/folder123" },
    ]);
    expect(await db().select({ driveFolderUrl: reportRunScopes.driveFolderUrl, driveFolderName: reportRunScopes.driveFolderName }).from(reportRunScopes)).toEqual([
      { driveFolderUrl: "https://drive.google.com/drive/folders/folder123", driveFolderName: "蝦皮" },
    ]);
    await as(admin, "eli@ecotech.tw", `/api/tools/scopes/${encodeURIComponent(shopeeScopeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ driveFolderUrl: "https://drive.google.com/drive/folders/folder456", driveFolderName: "蝦皮新資料夾" }),
    });
    expect(await listShopeeSalesRuns(db())).toMatchObject([{ driveFolderUrl: "https://drive.google.com/drive/folders/folder123" }]);
    const state = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/state");
    expect((await state.json()) as { latestRequestId: string }).toMatchObject({ latestRequestId: expect.any(String) });
    expect((await getShopeeSalesSettings(db())).driveFolderName).toBe("蝦皮新資料夾");

    const source = await app.fetch(new Request(sourceUrl), env as never);
    expect(source.status).toBe(200);
    expect(source.headers.get("x-shopee-report-password")).toBe("MDQyMjEz");
    const cleanupUrl = sourceUrl.replace("/source/", "/cleanup/");
    expect((await app.fetch(new Request(cleanupUrl, { method: "POST" }), env as never)).status).toBe(200);
    expect((await app.fetch(new Request(sourceUrl), env as never)).status).toBe(404);
  });

  it("通路設定權限可以讀蝦皮報表設定", async () => {
    await db().insert(roles).values({ id: "role-tools-config", roleKey: "tools-config", name: "通路設定", isSystem: false });
    await db().insert(rolePermissionGrants).values([
      { roleId: "role-tools-config", permission: "tools:payout:config" },
      { roleId: "role-tools-config", permission: "reports:cyberbiz:write" },
    ]);
    const id = await seedUser("tools-config@ecotech.tw", "role-tools-config");

    expect((await as(id, "tools-config@ecotech.tw", "/api/tools/shopee-sales/settings")).status).toBe(200);

    // 寫入改走通路管理，不再有第二個設定端點。
    const scopeId = (await getShopeeSalesSettings(db())).id;
    const saved = await as(id, "tools-config@ecotech.tw", `/api/tools/scopes/${encodeURIComponent(scopeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ driveFolderUrl: "https://drive.google.com/drive/folders/folder123" }),
    });
    expect(saved.status).toBe(200);
  });

  it("檢視者不能執行", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/tools/shopee-sales/state");
    expect(response.status).toBe(403);
  });
});
