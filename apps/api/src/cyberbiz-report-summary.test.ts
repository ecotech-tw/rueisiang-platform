import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  createDatabase,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  syncSystemRoles,
  upsertReportScope,
} from "@rueisiang/db";
import { cyberbizProductCatalog, itemCategories, items, reportExternalProducts, users, userRoleAssignments } from "@rueisiang/db/schema";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() { return createDatabase(d1 as never); }

async function seedCyberbizProduct(input: {
  itemId: string;
  sku: string;
  productId: string;
  variantId: string;
  productName: string;
  variantName?: string;
}): Promise<void> {
  await db().insert(items).values({ id: input.itemId, source: "cyberbiz", kind: "sellable", sku: input.sku, name: [input.productName, input.variantName].filter(Boolean).join(" - ") || input.sku, active: 1 });
  await db().insert(cyberbizProductCatalog).values({ itemId: input.itemId, cyberbizProductId: input.productId, cyberbizVariantId: input.variantId, productName: input.productName, variantName: input.variantName ?? "", published: 1, rawJson: "{}", syncStatus: "synced" });
}

async function targetSalesRows(): Promise<Array<{ reportMonth: string; sku: string; productName: string; category: string; salesAmount: number }>> {
  return db().all(sql`SELECT sales.report_month AS reportMonth, item.sku AS sku, item.name AS productName, COALESCE(category.name, '未分類') AS category, sales.sales_amount AS salesAmount
    FROM report_item_sales_monthly AS sales
    INNER JOIN items AS item ON item.id = sales.item_id
    LEFT JOIN item_categories AS category ON category.id = item.category_id
    WHERE sales.record_origin = 'imported'
    ORDER BY sales.report_month, item.sku`) as never;
}

async function seedUser(email: string, roleId: string): Promise<string> {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId });
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
  d1 = createTargetOnlyD1();
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
    // 停用的也要在清單裡，而且帶著 active——畫面靠它決定「篩選」與「可以寫入」
    // 兩個下拉各自要顯示什麼。
    expect(await options.json()).toMatchObject({
      scopes: [
        { id: "cyberbiz:store:disabled", name: "停用店", active: 0 },
        { id: scopeId, name: "啟用店", active: 1 },
        { id: "shopee:store:default", name: "蝦皮", active: 1 },
      ],
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
    expect(await payoutList.json()).toMatchObject({ rows: [{ payoutAmount: 4200 }] });
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
      rows: [{ sku: "IMPORTED-1", productName: "匯入商品", source: "imported", skuSource: "custom" }],
    });

    /*
     * 總筆數與當頁資料是分開的兩個查詢、走不同的快取 key（筆數只看篩選條件）。
     * 翻頁與換排序都不可以改變總筆數，也不可以變成只數當頁那幾列。
     */
    const sortedByAmount = await call(
      "/api/reports/cyberbiz/manual/payout?source=imported&pageSize=10&sortField=payoutAmount&sortDirection=asc",
      manager,
      "manager-list@ecotech.tw",
    );
    expect(await sortedByAmount.json()).toMatchObject({
      page: 1,
      total: 2,
      rows: [{ payoutAmount: 1200 }, { payoutAmount: 2300 }],
    });

    // 越界的頁沒有資料，但總筆數仍然是 2——不可以退化成「數當頁那幾列」。
    const emptySecondPage = await call(
      "/api/reports/cyberbiz/manual/payout?source=imported&pageSize=10&page=2&sortField=businessDate&sortDirection=desc",
      manager,
      "manager-list@ecotech.tw",
    );
    expect(await emptySecondPage.json()).toMatchObject({ page: 2, total: 2, rows: [] });
  });

  // 統計是歷史：停用店仍要出現在清單裡，不然它過去的數字沒有地方查。彙總那一列
  // 是容器、本身沒有資料，所以不進「選一個據點」的下拉。
  it("summary 與 scope 清單含停用通路但不含彙總，且由營運統計權限保護", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    await upsertReportScope(db(), { id: "shopee:store:default", scopeKind: "store", sourceType: "shopee", name: "蝦皮" });
    await insertReportPayoutDaily(db(), [{ scopeId: "cyberbiz:store:active", businessDate: "2026-08-01", payoutAmount: 2040 }]);
    await insertReportSalesMonthly(db(), [
      { scopeId: "cyberbiz:store:active", reportMonth: "2026-07", sku: "SKU-1", grossQuantity: 1, netQuantity: 1, salesAmount: 100 },
      { scopeId: "cyberbiz:store:active", reportMonth: "2026-08", sku: "SKU-1", grossQuantity: 2, netQuantity: 2, salesAmount: 200 },
      { scopeId: "shopee:store:default", reportMonth: "2026-08", sku: "SKU-SHOPEE", grossQuantity: 3, netQuantity: 3, salesAmount: 300 },
    ]);

    const scopes = await call("/api/reports/cyberbiz/scopes", admin, "admin@ecotech.tw");
    expect(scopes.status).toBe(200);
    expect(await scopes.json()).toEqual({
      latestSalesPeriod: "2026-08",
      scopes: [
        { id: "cyberbiz:store:disabled", name: "停用店", scopeType: "store", latestSalesPeriod: null },
        { id: "cyberbiz:store:active", name: "啟用店", scopeType: "store", latestSalesPeriod: "2026-08" },
        { id: "shopee:store:default", name: "蝦皮", scopeType: "store", latestSalesPeriod: "2026-08" },
      ],
    });

    const summary = await call("/api/reports/cyberbiz/summary/payout?period=2026-08", admin, "admin@ecotech.tw");
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      status: "ok",
      current: { total: 2040 },
      breakdown: [{ scopeId: "cyberbiz:store:active", value: 2040, channel: "cyberbiz" }],
    });
  });

  it("HTTP API 可以用 channel scope 查官網，而不是把它當成 company", async () => {
    const admin = await seedUser("admin-channel@ecotech.tw", "role-admin");
    const website = "cyberbiz:channel:shop";
    await upsertReportScope(db(), { id: website, scopeKind: "channel", name: "官網" });
    await insertReportSalesMonthly(db(), [{
      scopeId: website, reportMonth: "2026-08", sku: "WEB-001", productName: "官網商品", grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 500,
    }]);
    await insertReportPayoutDaily(db(), [{ scopeId: website, businessDate: "2026-08-01", payoutAmount: 600 }]);

    const scopeList = await call("/api/reports/cyberbiz/scopes", admin, "admin-channel@ecotech.tw");
    expect(scopeList.status).toBe(200);
    expect(await scopeList.json()).toMatchObject({
      scopes: expect.arrayContaining([{ id: website, name: "官網", scopeType: "channel", latestSalesPeriod: "2026-08" }]),
    });

    const encodedWebsite = encodeURIComponent("官網");
    const sales = await call(`/api/reports/cyberbiz/sales?period=2026-08&scopeType=channel&scopeName=${encodedWebsite}&groupBy=month%2Csku`, admin, "admin-channel@ecotech.tw");
    expect(sales.status).toBe(200);
    expect(await sales.json()).toMatchObject({ status: "ok", scopeType: "channel", scopeId: website, totals: { netQuantity: 4, salesAmount: 500 } });

    const payout = await call(`/api/reports/cyberbiz/payout?period=2026-08&scopeType=channel&scopeName=${encodedWebsite}`, admin, "admin-channel@ecotech.tw");
    expect(payout.status).toBe(200);
    expect(await payout.json()).toMatchObject({ status: "ok", scopeType: "channel", scopeId: website, totals: { payoutAmount: 600 } });
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

  // 通路管理是唯一的入口：列出每一個通路，不挑 source 也不挑 kind。
  it("通路管理可以新增、改名、改種類與來源、停用與封存", async () => {
    const manager = await seedUser("manager-scope-management@ecotech.tw", "role-manager");

    await upsertReportScope(db(), { id: "shopee:store:default", scopeKind: "store", sourceType: "shopee", name: "蝦皮" });

    const initial = await call("/api/tools/scopes", manager, "manager-scope-management@ecotech.tw");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      scopes: [
        { id: "company", name: "公司整體", scopeKind: "company", active: true, archivedAt: null },
        { id: "cyberbiz:store:active", name: "啟用店", sourceType: "cyberbiz", active: true },
        { id: "shopee:store:default", name: "蝦皮", sourceType: "shopee", active: true },
        { id: "cyberbiz:store:disabled", name: "停用店", active: false },
      ],
    });

    const created = await mutate(
      "/api/tools/scopes",
      "POST",
      manager,
      "manager-scope-management@ecotech.tw",
      { name: "歷史通路" },
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { scope: { id: string } };
    expect(createdBody.scope.id).toMatch(/^manual:store:/u);

    // 種類、來源與外部店名都是可管理的欄位，不是從 ID 前綴推出來的。
    const updated = await mutate(
      `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      manager,
      "manager-scope-management@ecotech.tw",
      { name: "蝦皮二館" },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      scope: { id: createdBody.scope.id, name: "蝦皮二館", active: true },
    });

    // 來源、種類、外部店名與 Drive 只有管理者能改；合併成一頁不該順便放寬權限。
    // 外部店名決定 runner 去後台抓哪一家店的錢，所以跟 Drive 同一層。
    for (const payload of [{ scopeKind: "channel" }, { externalName: "蝦皮二館賣場" }]) {
      const forbidden = await mutate(
        `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}`,
        "PATCH",
        manager,
        "manager-scope-management@ecotech.tw",
        payload,
      );
      expect(forbidden.status).toBe(403);
    }

    const admin = await seedUser("admin-scope-management@ecotech.tw", "role-admin");
    const configured = await mutate(
      `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      admin,
      "admin-scope-management@ecotech.tw",
      { scopeKind: "channel", sourceType: "Shopee", externalName: "蝦皮二館賣場", driveFolderUrl: "https://drive.google.com/drive/folders/abc" },
    );
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      scope: {
        scopeKind: "channel", sourceType: "shopee", externalName: "蝦皮二館賣場",
        driveFolderUrl: "https://drive.google.com/drive/folders/abc",
      },
    });

    const badKind = await mutate(
      `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      admin,
      "admin-scope-management@ecotech.tw",
      { scopeKind: "warehouse" },
    );
    expect(badKind.status).toBe(400);

    // Drive 連結對沒有 config 權限的人整個不回傳，不是只有畫面上藏起來。
    const managerView = await call("/api/tools/scopes", manager, "manager-scope-management@ecotech.tw");
    const managerRows = (await managerView.json() as { scopes: Array<{ id: string; driveFolderUrl: string }> }).scopes;
    expect(managerRows.find((scope) => scope.id === createdBody.scope.id)?.driveFolderUrl).toBe("");

    // 停用只是不再出現在補登選單；封存才會從管理清單收起來。兩者都不刪資料。
    const disabled = await mutate(
      `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      manager,
      "manager-scope-management@ecotech.tw",
      { active: false },
    );
    expect(disabled.status).toBe(200);
    // 停用之後仍然在清單裡，但 active 是 0：報表管理要篩得到它過去的紀錄，
    // 同一份清單濾掉 active=0 之後才是「可以寫入新資料」的那些。
    const options = await call("/api/reports/cyberbiz/manual/options", manager, "manager-scope-management@ecotech.tw");
    expect((await options.json() as { scopes: Array<{ id: string; active: number }> }).scopes)
      .toContainEqual(expect.objectContaining({ id: createdBody.scope.id, active: 0 }));

    const archived = await mutate(
      `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}/archive`,
      "POST",
      manager,
      "manager-scope-management@ecotech.tw",
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ scope: { id: createdBody.scope.id, active: false } });
    const afterArchive = await call("/api/tools/scopes", manager, "manager-scope-management@ecotech.tw");
    const rows = (await afterArchive.json() as { scopes: Array<{ id: string; archivedAt: string | null }> }).scopes;
    expect(rows.find((scope) => scope.id === createdBody.scope.id)?.archivedAt).toEqual(expect.any(String));
    // 封存的通路仍然在資料庫裡，歷史查得到。
    expect(rows).toHaveLength(5);

    // 重新啟用會一併解除封存，不然「停用」與「封存」會互相打架。
    const restored = await mutate(
      `/api/tools/scopes/${encodeURIComponent(createdBody.scope.id)}`,
      "PATCH",
      manager,
      "manager-scope-management@ecotech.tw",
      { active: true },
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ scope: { active: true, archivedAt: null } });
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

    await seedCyberbizProduct({
      itemId: "item-import-1",
      sku: "SKU-1",
      productId: "import-product-1",
      variantId: "import-variant-1",
      productName: "商品一",
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

    const duplicateScope = await mutate(
      "/api/reports/cyberbiz/manual/import/payout",
      "POST",
      manager,
      "manager-report-import@ecotech.tw",
      { scopeName: "匯入據點", rows: [{ businessDate: "2026-08-03", payoutAmount: 1 }] },
    );
    expect(duplicateScope.status).toBe(409);

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
      { scopeId: "有空白 的 id", scopeName: "錯誤 scope", rows: [{ businessDate: "2026-08-01", payoutAmount: 1 }] },
    )).status).toBe(400);
  });

  it("standard sales import keeps every uploaded field and accepts multiple months", async () => {
    const manager = await seedUser("manager-standard-report-import@ecotech.tw", "role-manager");
    await db().insert(itemCategories).values([
      { id: "standard-category-1", depth: 0, parentId: null, parentDepth: null, name: "上傳分類", color: "rose", sortOrder: 0, active: 1 },
      { id: "standard-category-2", depth: 0, parentId: null, parentDepth: null, name: "另一個分類", color: "rose", sortOrder: 1, active: 1 },
    ]);
    const response = await mutate(
      "/api/reports/cyberbiz/manual/import/sales",
      "POST",
      manager,
      "manager-standard-report-import@ecotech.tw",
      {
        format: "standard",
        scopeId: "cyberbiz:store:active",
        scopeName: "啟用店",
        rows: [
          {
            reportMonth: "2026-08",
            sku: "standard-001",
            productName: "上傳商品名稱",
            category: "上傳分類",
            grossQuantity: 3,
            returnQuantity: 1,
            netQuantity: 2,
            salesAmount: 250,
          },
          {
            reportMonth: "2026-09",
            sku: "standard-002",
            productName: "另一個商品",
            category: "另一個分類",
            grossQuantity: 5,
            returnQuantity: 0,
            netQuantity: 5,
            salesAmount: 900,
          },
        ],
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      reportMonth: null,
      reportMonths: ["2026-08", "2026-09"],
      rowCount: 2,
      totals: { grossQuantity: 8, returnQuantity: 1, netQuantity: 7, salesAmount: 1150 },
    });
    expect(await targetSalesRows()).toEqual([
      { reportMonth: "2026-08", sku: "STANDARD-001", productName: "上傳商品名稱", category: "上傳分類", salesAmount: 250 },
      { reportMonth: "2026-09", sku: "STANDARD-002", productName: "另一個商品", category: "另一個分類", salesAmount: 900 },
    ]);
  });

  it("manual sales import merges rows without deleting unlisted monthly data", async () => {
    const manager = await seedUser("manager-report-import-merge@ecotech.tw", "role-manager");
    const scopeId = "cyberbiz:store:merge";
    await upsertReportScope(db(), { id: scopeId, scopeKind: "store", name: "部分月份據點" });
    await insertReportSalesMonthly(db(), [{
      scopeId,
      reportMonth: "2026-08",
      sku: "OLD-SKU",
      productName: "既有商品",
      grossQuantity: 8,
      netQuantity: 8,
      salesAmount: 800,
    }]);
    await seedCyberbizProduct({
      itemId: "item-merge-new",
      sku: "NEW-SKU",
      productId: "merge-product",
      variantId: "merge-variant",
      productName: "新商品",
    });

    const response = await mutate(
      "/api/reports/cyberbiz/manual/import/sales",
      "POST",
      manager,
      "manager-report-import-merge@ecotech.tw",
      {
        scopeId,
        scopeName: "部分月份據點",
        reportMonth: "2026-08",
        rows: [{
          sku: "NEW-SKU",
          productName: "新商品",
          category: "未分類",
          grossQuantity: 2,
          returnQuantity: 0,
          netQuantity: 2,
          salesAmount: 200,
        }],
      },
    );
    expect(response.status).toBe(201);
    expect(await targetSalesRows()).toEqual([
      { reportMonth: "2026-08", sku: "NEW-SKU", productName: "新商品", category: "未分類", salesAmount: 200 },
      { reportMonth: "2026-08", sku: "OLD-SKU", productName: "既有商品", category: "未分類", salesAmount: 800 },
    ]);
  });

  it("舊版商品名稱會沿用既有 CYBERBIZ mapping 自動補 SKU，匯入後寫入系統商品", async () => {
    await db().insert(items).values({
      id: "target-sales-item",
      source: "custom",
      kind: "sellable",
      sku: "SOAP-SYSTEM",
      name: "美膚皂",
      categoryId: null,
      active: 1,
    });
    await db().insert(reportExternalProducts).values({
      id: "target-sales-mapping",
      sourceType: "cyberbiz",
      externalKey: "SOAP-CYBERBIZ",
      externalVariantKey: "",
      externalName: "醬釀美膚皂 -",
      resolution: "mapped",
      itemId: "target-sales-item",
      ignoredReason: "",
    });
    await seedCyberbizProduct({
      itemId: "target-cyberbiz-sales-item",
      sku: "SOAP-CYBERBIZ",
      productId: "target-sales-product",
      variantId: "target-sales-variant",
      productName: "目前的美膚皂名稱",
    });
    const manager = await seedUser("manager-report-import-mapping@ecotech.tw", "role-manager");

    const options = await call(
      "/api/reports/cyberbiz/manual/options",
      manager,
      "manager-report-import-mapping@ecotech.tw",
    );
    const optionsBody = await options.json() as { products: Array<{ sku: string; aliases?: string[] }> };
    const mappedProduct = optionsBody.products.find((product) => product.sku === "SOAP-CYBERBIZ");
    expect(mappedProduct?.aliases).toContain("醬釀美膚皂 -");

    const response = await mutate(
      "/api/reports/cyberbiz/manual/import/sales",
      "POST",
      manager,
      "manager-report-import-mapping@ecotech.tw",
      {
        scopeName: "歷史匯入店",
        reportMonth: "2026-08",
        rows: [{
          sku: "SOAP-CYBERBIZ",
          productName: "醬釀美膚皂 -",
          category: "未分類",
          grossQuantity: 19,
          returnQuantity: 0,
          netQuantity: 19,
          salesAmount: 0,
        }],
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      rowCount: 1,
      skippedSkus: [],
      totals: { grossQuantity: 19, returnQuantity: 0, netQuantity: 19, salesAmount: 0 },
    });
    expect(await targetSalesRows()).toEqual([{ reportMonth: "2026-08", sku: "SOAP-SYSTEM", productName: "美膚皂", category: "未分類", salesAmount: 0 }]);
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
      "/api/reports/cyberbiz/summary/payout?scopeType=store&scopeId=cyberbiz%3Astore%3Aactive&startDate=2026-08-03&endDate=2026-08-03",
      admin,
      "admin-effective-delete@ecotech.tw",
    );
    expect(await summary.json()).toMatchObject({ status: "NO_DATA_FOR_RANGE", current: { total: 0 } });
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

  it("batch deletes selected effective records and restores underlying imports", async () => {
    const admin = await seedUser("admin-batch-delete@ecotech.tw", "role-admin");
    const scopeId = "cyberbiz:store:active";
    await insertReportPayoutDaily(db(), [
      { scopeId, businessDate: "2026-08-04", payoutAmount: 400 },
      { scopeId, businessDate: "2026-08-05", payoutAmount: 500 },
    ]);
    await insertReportSalesMonthly(db(), [
      { scopeId, reportMonth: "2026-08", sku: "BATCH-A", productName: "商品 A", category: "分類", grossQuantity: 1, netQuantity: 1, salesAmount: 100 },
      { scopeId, reportMonth: "2026-08", sku: "BATCH-B", productName: "商品 B", category: "分類", grossQuantity: 2, netQuantity: 2, salesAmount: 200 },
    ]);

    const manualPayout = await mutate(
      "/api/reports/cyberbiz/manual/payout",
      "POST",
      admin,
      "admin-batch-delete@ecotech.tw",
      { scopeId, businessDate: "2026-08-04", payoutAmount: 450 },
    );
    const manualPayoutRow = (await manualPayout.json() as { row: { id: string; source: string; scopeId: string; businessDate: string } }).row;
    const manualSales = await mutate(
      "/api/reports/cyberbiz/manual/sales",
      "POST",
      admin,
      "admin-batch-delete@ecotech.tw",
      {
        scopeId,
        reportMonth: "2026-08",
        skuSource: "custom",
        sku: "BATCH-A",
        productName: "人工商品 A",
        category: "人工分類",
        grossQuantity: 3,
        returnQuantity: 0,
        netQuantity: 3,
        salesAmount: 300,
      },
    );
    const manualSalesRow = (await manualSales.json() as { row: { id: string; source: string; scopeId: string; reportMonth: string; sku: string } }).row;

    const payoutList = await call(
      "/api/reports/cyberbiz/manual/payout?source=all",
      admin,
      "admin-batch-delete@ecotech.tw",
    );
    const payoutRows = (await payoutList.json() as { rows: Array<{ id: string; source: string; scopeId: string; businessDate: string }> }).rows;
    const importedPayoutRow = payoutRows.find((row) => row.source === "imported");
    expect(importedPayoutRow).toMatchObject({ businessDate: "2026-08-05" });

    const salesList = await call(
      "/api/reports/cyberbiz/manual/sales?source=all",
      admin,
      "admin-batch-delete@ecotech.tw",
    );
    const salesRows = (await salesList.json() as { rows: Array<{ id: string; source: string; scopeId: string; reportMonth: string; sku: string }> }).rows;
    const importedSalesRow = salesRows.find((row) => row.source === "imported");
    expect(importedSalesRow).toMatchObject({ sku: "BATCH-B" });

    const payoutDelete = await mutate(
      "/api/reports/cyberbiz/manual/payout/records",
      "DELETE",
      admin,
      "admin-batch-delete@ecotech.tw",
      { records: [manualPayoutRow, importedPayoutRow] },
    );
    expect(payoutDelete.status).toBe(200);
    expect(await payoutDelete.json()).toMatchObject({ ok: true, deletedCount: 2 });

    const salesDelete = await mutate(
      "/api/reports/cyberbiz/manual/sales/records",
      "DELETE",
      admin,
      "admin-batch-delete@ecotech.tw",
      { records: [manualSalesRow, importedSalesRow] },
    );
    expect(salesDelete.status).toBe(200);
    expect(await salesDelete.json()).toMatchObject({ ok: true, deletedCount: 2 });

    expect(await db().all(sql`SELECT business_date AS businessDate, payout_amount AS payoutAmount
      FROM report_payout_daily WHERE record_origin = 'imported'`)).toEqual([{ businessDate: "2026-08-04", payoutAmount: 400 }]);
    expect(await targetSalesRows()).toEqual([{ reportMonth: "2026-08", sku: "BATCH-A", productName: "人工商品 A", category: "未分類", salesAmount: 100 }]);
  });
});
