import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  SHOP_SCOPE_ID,
  createDatabase,
  listCyberbizReportRuns,
  listShopReportRuns,
  seedPayoutStores,
  syncSystemRoles,
} from "@rueisiang/db";
import { reportRuns, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";

let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string, init: RequestInit = {}) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://platform.rueisiang.com${path}`, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
    env as never,
  );
}

function stubGithub() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: 204 });
  });
  return calls;
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GITHUB_TOKEN: "gh-token",
    PAYOUT_GITHUB_REPO: "ecotech-tw/rueisiang-platform",
    PAYOUT_WORKFLOW_FILE: "payout.yml",
    CYBERBIZ_SHOP_GITHUB_REF: "main",
  };
  await syncSystemRoles(db());
  await seedPayoutStores(db());
  await db().insert(scopes).values({
    id: SHOP_SCOPE_ID,
    sourceType: "cyberbiz",
    scopeKind: "channel",
    name: "官網",
    normalizedName: "官網",
    driveFolderUrl: "https://drive.google.com/drive/folders/configured",
    driveFolderName: "官網報表",
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("官網對帳單執行", () => {
  it("送出月份範圍並留下 audit record", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-09" }),
    });

    expect(response.status).toBe(202);
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining("/actions/workflows/cyberbiz-shop-report.yml/dispatches"),
      body: { ref: "main", inputs: { start_month: "2026-08", end_month: "2026-09", drive_folder_url: "https://drive.google.com/drive/folders/configured" } },
    });

    const [run] = await listShopReportRuns(db());
    expect(run).toMatchObject({ startMonth: "2026-08", endMonth: "2026-09", actorEmail: "manager@ecotech.tw" });
    // 結束月份要換成那個月的最後一天，否則 report_runs 的區間會少掉後半個月。
    const [stored] = await db().select().from(reportRuns).where(eq(reportRuns.requestId, run!.requestId));
    expect(stored).toMatchObject({
      startDate: "2026-08-01",
      endDate: "2026-09-30",
      // 一份對帳單同時帶商品銷售與撥款。
      importsSales: 1,
      importsPayout: 1,
      periodKind: "custom",
    });

    // 官網是通路不是櫃點：kind 錯了它就會跑進出金表與 HR 的據點清單。
    const [scope] = await db().select().from(scopes).where(eq(scopes.id, SHOP_SCOPE_ID));
    expect(scope).toMatchObject({ scopeKind: "channel", sourceType: "cyberbiz", name: "官網" });
  });

  it("官網的執行紀錄不會混進門市的商品銷售與出金清單", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-08" }),
    });

    expect(await listCyberbizReportRuns(db(), "sales")).toHaveLength(0);
    expect(await listCyberbizReportRuns(db(), "payout")).toHaveLength(0);
    expect(await listShopReportRuns(db())).toHaveLength(1);
  });

  it("月份格式錯或顛倒都不觸發 workflow", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const bad = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-8", endMonth: "2026-08" }),
    });
    const reversed = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-09", endMonth: "2026-08" }),
    });

    expect(bad.status).toBe(400);
    expect(reversed.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await listShopReportRuns(db())).toHaveLength(0);
  });

  it("GitHub 拒絕觸發時，那一列會標成 failed 而不是留著假的 queued", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-08" }),
    });

    expect(response.status).toBe(502);
    // 先寫再觸發：紀錄留著才知道誰按過，但狀態要說實話。
    const [stored] = await db().select().from(reportRuns).where(eq(reportRuns.sourceType, "cyberbiz"));
    expect(stored).toMatchObject({ status: "failed" });
    expect(stored!.lastError).toContain("GITHUB_TOKEN");
  });

  it("沒有權限的人打不動這三條路由", async () => {
    const calls = stubGithub();
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    const state = await as(id, "staff@ecotech.tw", "/api/tools/shop-report/state");
    const run = await as(id, "staff@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-08" }),
    });
    const status = await as(id, "staff@ecotech.tw", "/api/tools/shop-report/status?requestId=shop:x");

    expect([state.status, run.status, status.status]).toEqual([403, 403, 403]);
    expect(calls).toHaveLength(0);
  });

  it("沒設定 GitHub repo 時 state 回報未設定，執行則回 503", async () => {
    // workflow 檔名寫死在程式裡，所以「有沒有設定」只看 token 與 repo。
    delete env.PAYOUT_GITHUB_REPO;
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const state = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/state");
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ configured: false });

    const run = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-08" }),
    });
    expect(run.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("沒設定官網 Drive 資料夾時 state 與執行都回報未設定", async () => {
    await db().update(scopes).set({ driveFolderUrl: "", driveFolderName: "" }).where(eq(scopes.id, SHOP_SCOPE_ID));
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const state = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/state");
    expect(await state.json()).toMatchObject({ configured: false, githubConfigured: true, driveFolderUrl: "" });
    const run = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-08" }),
    });
    expect(run.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("state 帶出上一個月當預設，並接回最近一次執行的識別碼", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const started = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/run", {
      method: "POST",
      body: JSON.stringify({ startMonth: "2026-08", endMonth: "2026-08" }),
    });
    const { requestId } = await started.json() as { requestId: string };

    const state = await as(id, "manager@ecotech.tw", "/api/tools/shop-report/state");
    const payload = await state.json() as { defaultStartMonth: string; defaultEndMonth: string; latestRequestId: string; driveFolderUrl: string };
    expect(payload.latestRequestId).toBe(requestId);
    expect(requestId.startsWith("shop:")).toBe(true);
    expect(payload.defaultStartMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(payload.defaultEndMonth).toBe(payload.defaultStartMonth);
    expect(payload.driveFolderUrl).toBe("https://drive.google.com/drive/folders/configured");
  });
});
