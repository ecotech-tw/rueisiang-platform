import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  createDatabase,
  insertReportPayoutDaily,
  syncSystemRoles,
  upsertReportScope,
} from "@rueisiang/db";
import { users, userRoles } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() { return createDatabase(d1 as never); }

async function seedUser(email: string, roleId: string): Promise<string> {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function cookieFor(userId: string, email: string): Promise<string> {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function call(path: string, userId?: string, email?: string): Promise<Response> {
  const headers = userId && email ? { Cookie: await cookieFor(userId, email) } : undefined;
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, { headers }), env as never);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T04:00:00.000Z"));
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(db());
  await upsertReportScope(db(), { id: "cyberbiz:store:active", scopeKind: "store", name: "啟用店" });
  await upsertReportScope(db(), { id: "cyberbiz:store:disabled", scopeKind: "store", name: "停用店", active: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("報表統計 API", () => {
  it("沒有登入或沒有報表權限都不能讀 summary", async () => {
    expect((await call("/api/reports/cyberbiz/summary/payout?period=2026-08")).status).toBe(401);

    const viewer = await seedUser("viewer@ecotech.tw", "role-viewer");
    expect((await call("/api/reports/cyberbiz/summary/payout?period=2026-08", viewer, "viewer@ecotech.tw")).status).toBe(403);
  });

  it("summary 與 scope 清單由同一個 reports 權限保護，且不回傳停用店", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    await insertReportPayoutDaily(db(), [{ scopeId: "cyberbiz:store:active", businessDate: "2026-08-01", payoutAmount: 2040 }]);

    const scopes = await call("/api/reports/cyberbiz/scopes", admin, "admin@ecotech.tw");
    expect(scopes.status).toBe(200);
    expect(await scopes.json()).toEqual({ scopes: [{ id: "cyberbiz:store:active", name: "啟用店" }] });

    const summary = await call("/api/reports/cyberbiz/summary/payout?period=2026-08", admin, "admin@ecotech.tw");
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      status: "ok",
      current: { total: 2040 },
      breakdown: [{ scopeId: "cyberbiz:store:active", value: 2040, channel: "cyberbiz" }],
    });
  });

  it("商品 summary 的非整月查詢回傳明確狀態，且可拒絕未知 Top SKU 排序", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");

    const unsupported = await call(
      "/api/reports/cyberbiz/summary/sales?startDate=2026-08-02&endDate=2026-08-20&scopeType=company",
      admin,
      "admin@ecotech.tw",
    );
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ status: "UNSUPPORTED_GRANULARITY" });

    const invalid = await call(
      "/api/reports/cyberbiz/summary/sales?period=2026-08&topSkuBy=unknown",
      admin,
      "admin@ecotech.tw",
    );
    expect(invalid.status).toBe(400);
  });
});
