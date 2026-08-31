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

  it("人工修訂清單包含匯入資料，並支援來源與日期篩選", async () => {
    const manager = await seedUser("manager-list@ecotech.tw", "role-manager");
    const scopeId = "cyberbiz:store:active";
    await insertReportPayoutDaily(db(), [
      { scopeId, businessDate: "2026-08-01", payoutAmount: 1200 },
      { scopeId, businessDate: "2026-08-02", payoutAmount: 2300 },
    ]);
    await insertReportSalesMonthly(db(), [{
      scopeId,
      reportMonth: "2026-08",
      sku: "IMPORTED-1",
      productName: "匯入商品",
      grossQuantity: 4,
      netQuantity: 4,
      salesAmount: 400,
    }]);

    const payout = await call(
      "/api/reports/cyberbiz/manual/payout?source=imported&startDate=2026-08-02&endDate=2026-08-02",
      manager,
      "manager-list@ecotech.tw",
    );
    expect(payout.status).toBe(200);
    expect(await payout.json()).toMatchObject({
      page: 1,
      pageSize: 25,
      total: 1,
      rows: [{ scopeId, businessDate: "2026-08-02", payoutAmount: 2300, source: "imported" }],
    });

    const sales = await call(
      "/api/reports/cyberbiz/manual/sales?search=IMPORTED-1&source=imported",
      manager,
      "manager-list@ecotech.tw",
    );
    expect(sales.status).toBe(200);
    expect(await sales.json()).toMatchObject({
      total: 1,
      rows: [{ sku: "IMPORTED-1", productName: "匯入商品", source: "imported", skuSource: null }],
    });
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

  it("report management can create, rename, disable, and re-enable report scopes", async () => {
    const manager = await seedUser("manager-scope-management@ecotech.tw", "role-manager");

    const initial = await call(
      "/api/reports/cyberbiz/manual/scopes",
      manager,
      "manager-scope-management@ecotech.tw",
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      scopes: [
        { id: "cyberbiz:store:active", name: "啟用店", active: true },
        { id: "cyberbiz:store:disabled", name: "停用店", active: false },
      ],
    });

    const created = await mutate(
      "/api/reports/cyberbiz/manual/scopes",
      "POST",
      manager,
      "manager-scope-management@ecotech.tw",
      { name: "歷史據點" },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { scope: { id: string; name: string; active: boolean } };
    expect(createdBody.scope).toMatchObject({ name: "歷史據點", active: true });
    expect(createdBody.scope.id).toMatch(/^manual:store:/u);

    const renamed = await mutate(
      `/api/reports/cyberbiz/manual/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      manager,
      "manager-scope-management@ecotech.tw",
      { name: "歷史據點（北區）", active: false },
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      scope: { id: createdBody.scope.id, name: "歷史據點（北區）", active: false },
    });

    const disabledOptions = await call(
      "/api/reports/cyberbiz/manual/options",
      manager,
      "manager-scope-management@ecotech.tw",
    );
    expect((await disabledOptions.json() as { scopes: Array<{ id: string }> }).scopes)
      .not.toContainEqual({ id: createdBody.scope.id });

    const reenabled = await mutate(
      `/api/reports/cyberbiz/manual/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      manager,
      "manager-scope-management@ecotech.tw",
      { active: true },
    );
    expect(reenabled.status).toBe(200);
    expect(await reenabled.json()).toMatchObject({
      scope: { id: createdBody.scope.id, name: "歷史據點（北區）", active: true },
    });

    const disabled = await mutate(
      `/api/reports/cyberbiz/manual/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "DELETE",
      manager,
      "manager-scope-management@ecotech.tw",
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      scope: { id: createdBody.scope.id, name: "歷史據點（北區）", active: false },
    });
  });

  it("report management imports payout and sales snapshots with duplicate rows aggregated", async () => {
    const manager = await seedUser("manager-report-import@ecotech.tw", "role-manager");

    const payout = await mutate(
      "/api/reports/cyberbiz/manual/import/payout",
      "POST",
      manager,
      "manager-report-import@ecotech.tw",
      {
        scopeName: "匯入據點",
        rows: [
          { businessDate: "2026-08-01", payoutAmount: 1200 },
          { businessDate: "2026-08-01", payoutAmount: 300 },
          { businessDate: "2026-08-02", payoutAmount: 500 },
        ],
      },
    );
    expect(payout.status).toBe(201);
    const payoutBody = await payout.json() as {
      scopeId: string;
      dayCount: number;
      total: number;
      coverageStart: string;
      coverageEnd: string;
    };
    expect(payoutBody).toMatchObject({
      dayCount: 2,
      total: 2000,
      coverageStart: "2026-08-01",
      coverageEnd: "2026-08-02",
    });

    const payoutList = await call(
      `/api/reports/cyberbiz/manual/payout?scopeId=${encodeURIComponent(payoutBody.scopeId)}&source=imported`,
      manager,
      "manager-report-import@ecotech.tw",
    );
    expect(await payoutList.json()).toMatchObject({
      total: 2,
      rows: [
        { businessDate: "2026-08-02", payoutAmount: 500, source: "imported" },
        { businessDate: "2026-08-01", payoutAmount: 1500, source: "imported" },
      ],
    });

    const sales = await mutate(
      "/api/reports/cyberbiz/manual/import/sales",
      "POST",
      manager,
      "manager-report-import@ecotech.tw",
      {
        scopeId: payoutBody.scopeId,
        scopeName: "匯入據點",
        reportMonth: "2026-08",
        rows: [
          { sku: "sku-1", productName: "商品一", category: "分類", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 200 },
          { sku: "SKU-1", productName: "商品一", category: "分類", grossQuantity: 1, returnQuantity: 1, netQuantity: 0, salesAmount: 50 },
        ],
      },
    );
    expect(sales.status).toBe(201);
    expect(await sales.json()).toMatchObject({
      reportMonth: "2026-08",
      rowCount: 1,
      totals: { grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 250 },
    });

    const salesList = await call(
      `/api/reports/cyberbiz/manual/sales?scopeId=${encodeURIComponent(payoutBody.scopeId)}&source=imported`,
      manager,
      "manager-report-import@ecotech.tw",
    );
    expect(await salesList.json()).toMatchObject({
      total: 1,
      rows: [{ sku: "SKU-1", grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 250 }],
    });

    expect((await mutate(
      "/api/reports/cyberbiz/manual/import/payout",
      "POST",
      manager,
      "manager-report-import@ecotech.tw",
      { scopeName: "錯誤日期", rows: [{ businessDate: "2026-02-31", payoutAmount: 1 }] },
    )).status).toBe(400);
    expect((await mutate(
      "/api/reports/cyberbiz/manual/import/payout",
      "POST",
      manager,
      "manager-report-import@ecotech.tw",
      { scopeId: "invalid-scope-id", scopeName: "錯誤 scope", rows: [{ businessDate: "2026-08-01", payoutAmount: 1 }] },
    )).status).toBe(400);
  });

  it("deletes the effective imported record and removes it from report summaries", async () => {
    const admin = await seedUser("admin-effective-delete@ecotech.tw", "role-admin");
    const scopeId = "cyberbiz:store:active";
    await insertReportPayoutDaily(db(), [{ scopeId, businessDate: "2026-08-03", payoutAmount: 2040 }]);
    await insertReportSalesMonthly(db(), [{
      scopeId,
      reportMonth: "2026-08",
      sku: "DELETE-ME",
      productName: "待刪除商品",
      grossQuantity: 1,
      netQuantity: 1,
      salesAmount: 100,
    }]);

    const payoutList = await call(
      "/api/reports/cyberbiz/manual/payout?source=imported",
      admin,
      "admin-effective-delete@ecotech.tw",
    );
    const payoutRow = (await payoutList.json() as { rows: Array<{ id: string; scopeId: string; businessDate: string }> }).rows[0];
    expect(payoutRow).toMatchObject({ scopeId, businessDate: "2026-08-03" });

    const salesList = await call(
      "/api/reports/cyberbiz/manual/sales?source=imported",
      admin,
      "admin-effective-delete@ecotech.tw",
    );
    const salesRow = (await salesList.json() as { rows: Array<{ id: string; scopeId: string; reportMonth: string; sku: string }> }).rows[0];
    expect(salesRow).toMatchObject({ scopeId, reportMonth: "2026-08", sku: "DELETE-ME" });

    expect((await mutate(
      "/api/reports/cyberbiz/manual/payout/record",
      "DELETE",
      admin,
      "admin-effective-delete@ecotech.tw",
      { source: "imported", ...payoutRow },
    )).status).toBe(200);
    expect((await mutate(
      "/api/reports/cyberbiz/manual/sales/record",
      "DELETE",
      admin,
      "admin-effective-delete@ecotech.tw",
      { source: "imported", ...salesRow },
    )).status).toBe(200);

    const summary = await call(
      "/api/reports/cyberbiz/summary/payout/daily?scopeType=store&scopeId=cyberbiz%3Astore%3Aactive&startDate=2026-08-03&endDate=2026-08-03",
      admin,
      "admin-effective-delete@ecotech.tw",
    );
    expect(await summary.json()).toMatchObject({ status: "NO_DATA_FOR_RANGE", totals: { payoutAmount: 0 }, rows: [] });
    expect((await (await call(
      "/api/reports/cyberbiz/manual/payout?source=imported",
      admin,
      "admin-effective-delete@ecotech.tw",
    )).json() as { total: number }).total).toBe(0);
    expect((await (await call(
      "/api/reports/cyberbiz/manual/sales?source=imported",
      admin,
      "admin-effective-delete@ecotech.tw",
    )).json() as { total: number }).total).toBe(0);
  });
});
