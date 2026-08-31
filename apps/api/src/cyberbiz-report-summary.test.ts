import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  createDatabase,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
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

async function mutate(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  userId?: string,
  email?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId && email) headers.Cookie = await cookieFor(userId, email);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env as never);
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
  it("可以新增、讀取與刪除兩種報表的人工資料，並驗證權限與日期", async () => {
    const manager = await seedUser("manager-manual@ecotech.tw", "role-manager");
    const viewer = await seedUser("viewer-manual@ecotech.tw", "role-viewer");
    const scopeId = "cyberbiz:store:active";

    const options = await call("/api/reports/cyberbiz/manual/options", manager, "manager-manual@ecotech.tw");
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({
      scopes: [{ id: scopeId, name: "啟用店" }],
      products: [],
    });

    const payout = await mutate(
      "/api/reports/cyberbiz/manual/payout",
      "POST",
      manager,
      "manager-manual@ecotech.tw",
      { scopeId, businessDate: "2026-08-01", payoutAmount: 4200 },
    );
    expect(payout.status).toBe(201);
    const payoutBody = await payout.json() as { row: { id: string; payoutAmount: number } };
    expect(payoutBody.row.payoutAmount).toBe(4200);

    const sales = await mutate(
      "/api/reports/cyberbiz/manual/sales",
      "POST",
      manager,
      "manager-manual@ecotech.tw",
      {
        scopeId,
        reportMonth: "2026-08",
        skuSource: "custom",
        sku: "manual-1",
        productName: "人工商品",
        grossQuantity: 3,
        returnQuantity: 0,
        netQuantity: 3,
        salesAmount: 180,
      },
    );
    expect(sales.status).toBe(201);

    const payoutList = await call("/api/reports/cyberbiz/manual/payout", manager, "manager-manual@ecotech.tw");
    expect(await payoutList.json()).toMatchObject({ rows: [{ id: payoutBody.row.id, payoutAmount: 4200 }] });
    const salesList = await call("/api/reports/cyberbiz/manual/sales", manager, "manager-manual@ecotech.tw");
    expect(await salesList.json()).toMatchObject({ rows: [{ sku: "MANUAL-1", productName: "人工商品" }] });

    expect((await mutate(
      "/api/reports/cyberbiz/manual/payout",
      "POST",
      manager,
      "manager-manual@ecotech.tw",
      { scopeId, businessDate: "2026-02-30", payoutAmount: 100 },
    )).status).toBe(400);
    expect((await mutate(
      "/api/reports/cyberbiz/manual/payout",
      "POST",
      viewer,
      "viewer-manual@ecotech.tw",
      { scopeId, businessDate: "2026-08-02", payoutAmount: 100 },
    )).status).toBe(403);

    expect((await mutate(
      `/api/reports/cyberbiz/manual/payout/${payoutBody.row.id}`,
      "DELETE",
      manager,
      "manager-manual@ecotech.tw",
    )).status).toBe(200);
  });

  it("沒有登入或沒有營運統計權限都不能讀 summary", async () => {
    expect((await call("/api/reports/cyberbiz/summary/payout?period=2026-08")).status).toBe(401);

    const viewer = await seedUser("viewer@ecotech.tw", "role-viewer");
    expect((await call("/api/reports/cyberbiz/summary/payout?period=2026-08", viewer, "viewer@ecotech.tw")).status).toBe(403);

    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    expect((await call("/api/reports/cyberbiz/summary/payout?period=2026-08", manager, "manager@ecotech.tw")).status).toBe(403);
  });

  it("summary 與 scope 清單由營運統計權限保護，且不回傳停用店", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    await insertReportPayoutDaily(db(), [{ scopeId: "cyberbiz:store:active", businessDate: "2026-08-01", payoutAmount: 2040 }]);
    await insertReportSalesMonthly(db(), [
      { scopeId: "cyberbiz:store:active", reportMonth: "2026-07", sku: "SKU-1", grossQuantity: 1, netQuantity: 1, salesAmount: 100 },
      { scopeId: "cyberbiz:store:active", reportMonth: "2026-08", sku: "SKU-1", grossQuantity: 2, netQuantity: 2, salesAmount: 200 },
    ]);

    const scopes = await call("/api/reports/cyberbiz/scopes", admin, "admin@ecotech.tw");
    expect(scopes.status).toBe(200);
    expect(await scopes.json()).toEqual({
      latestSalesPeriod: "2026-08",
      scopes: [{ id: "cyberbiz:store:active", name: "啟用店", latestSalesPeriod: "2026-08" }],
    });

    const summary = await call("/api/reports/cyberbiz/summary/payout?period=2026-08", admin, "admin@ecotech.tw");
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      status: "ok",
      current: { total: 2040 },
      breakdown: [{ scopeId: "cyberbiz:store:active", value: 2040, channel: "cyberbiz" }],
    });
  });

  it("可以編輯或刪除預覽中的單一日期，且寫入權限獨立受保護", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const viewer = await seedUser("viewer@ecotech.tw", "role-viewer");
    const scopeId = "cyberbiz:store:active";
    const path = `/api/reports/cyberbiz/payout/${encodeURIComponent(scopeId)}/2026-08-01`;
    await insertReportPayoutDaily(db(), [
      { scopeId, businessDate: "2026-08-01", payoutAmount: 2040 },
      { scopeId, businessDate: "2026-08-02", payoutAmount: 990 },
    ]);

    const managerUpdate = await mutate(path, "PATCH", manager, "manager@ecotech.tw", { payoutAmount: 3000 });
    expect(managerUpdate.status).toBe(200);
    expect(await managerUpdate.json()).toMatchObject({
      row: { scopeId, businessDate: "2026-08-01", payoutAmount: 3000 },
    });

    const viewerDelete = await mutate(path, "DELETE", viewer, "viewer@ecotech.tw");
    expect(viewerDelete.status).toBe(403);

    const daily = await call(
      `/api/reports/cyberbiz/summary/payout/daily?scopeType=store&scopeId=${encodeURIComponent(scopeId)}&startDate=2026-08-01&endDate=2026-08-02`,
      admin,
      "admin@ecotech.tw",
    );
    expect(daily.status).toBe(200);
    expect(await daily.json()).toMatchObject({
      status: "ok",
      totals: { payoutAmount: 3990 },
      rows: [
        { businessDate: "2026-08-01", payoutAmount: 3000 },
        { businessDate: "2026-08-02", payoutAmount: 990 },
      ],
    });

    const deleted = await mutate(path, "DELETE", admin, "admin@ecotech.tw");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    const remaining = await call(
      `/api/reports/cyberbiz/summary/payout/daily?scopeType=store&scopeId=${encodeURIComponent(scopeId)}&startDate=2026-08-01&endDate=2026-08-02`,
      admin,
      "admin@ecotech.tw",
    );
    expect(await remaining.json()).toMatchObject({
      status: "ok",
      totals: { payoutAmount: 990 },
      rows: [{ businessDate: "2026-08-02", payoutAmount: 990 }],
    });

    expect((await mutate(path, "DELETE", admin, "admin@ecotech.tw")).status).toBe(404);
  });

  it("拒絕無效日期、無效金額與不存在的逐日資料", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const scopeId = "cyberbiz:store:active";
    await insertReportPayoutDaily(db(), [{ scopeId, businessDate: "2026-08-01", payoutAmount: 2040 }]);

    expect((await mutate(
      `/api/reports/cyberbiz/payout/${encodeURIComponent(scopeId)}/2026-08-01`,
      "PATCH",
      admin,
      "admin@ecotech.tw",
      { payoutAmount: 3.5 },
    )).status).toBe(400);
    expect((await mutate(
      `/api/reports/cyberbiz/payout/${encodeURIComponent(scopeId)}/2026-02-30`,
      "PATCH",
      admin,
      "admin@ecotech.tw",
      { payoutAmount: 3000 },
    )).status).toBe(400);
    expect((await mutate(
      `/api/reports/cyberbiz/payout/${encodeURIComponent(scopeId)}/2026-08-03`,
      "PATCH",
      admin,
      "admin@ecotech.tw",
      { payoutAmount: 3000 },
    )).status).toBe(404);
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
