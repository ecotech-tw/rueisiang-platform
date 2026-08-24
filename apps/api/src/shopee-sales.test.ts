import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, getShopeeSalesSettings, listShopeeSalesRuns, syncSystemRoles } from "@rueisiang/db";
import { userRoles, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

function stubGithub(responses: { status?: number; body?: unknown }[] = [{ body: {} }]) {
  const calls: { url: string; body: unknown }[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
  });
  return calls;
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string, init: RequestInit = {}) {
  const token = await signSession(newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }), SECRET);
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, {
    ...init,
    headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  }), env as never);
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    SHOPEE_GITHUB_TOKEN: "gh-token",
    SHOPEE_GITHUB_REPO: "ecotech-tw/rueisiang-platform",
    SHOPEE_WORKFLOW_FILE: "shopee-sales-report.yml",
    SHOPEE_GITHUB_REF: "main",
  };
  await syncSystemRoles(db());
});

afterEach(() => vi.unstubAllGlobals());

describe("蝦皮銷售報表", () => {
  it("有執行權限的人可以讀到預設區間與空設定", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(id, "manager@ecotech.tw", "/api/tools/shopee-sales/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ start: "2026-07-01", end: "2026-07-31", settings: { driveFolderUrl: "" }, configured: true });
  });

  it("沒有 Drive 連結時不會觸發 GitHub", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(id, "manager@ecotech.tw", "/api/tools/shopee-sales/run", {
      method: "POST",
      body: JSON.stringify({ start: "2026-07-01", end: "2026-07-31" }),
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("管理者設定 Drive 後，執行會把資料夾連結帶給 workflow 並記錄操作者", async () => {
    const calls = stubGithub();
    const admin = await seedUser("eli@ecotech.tw", "role-admin");
    const saved = await as(admin, "eli@ecotech.tw", "/api/tools/shopee-sales/settings", {
      method: "PUT",
      body: JSON.stringify({ driveFolderUrl: "https://drive.google.com/drive/folders/folder123", driveFolderName: "蝦皮" }),
    });
    expect(saved.status).toBe(200);

    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(manager, "manager@ecotech.tw", "/api/tools/shopee-sales/run", {
      method: "POST",
      body: JSON.stringify({ start: "2026-07-01", end: "2026-07-31" }),
    });
    expect(response.status).toBe(202);
    expect(calls[0]).toMatchObject({ url: expect.stringContaining("shopee-sales-report.yml/dispatches"), body: { inputs: { start: "2026-07-01", end: "2026-07-31", drive_folder_url: "https://drive.google.com/drive/folders/folder123" } } });
    expect(await listShopeeSalesRuns(db())).toHaveLength(1);
    expect((await getShopeeSalesSettings(db())).driveFolderName).toBe("蝦皮");
  });

  it("檢視者不能執行", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/tools/shopee-sales/state");
    expect(response.status).toBe(403);
  });
});
