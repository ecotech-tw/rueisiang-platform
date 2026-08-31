import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, insertReportSalesMonthly, listCyberbizReportRuns, listPayoutStores, listReportScopes, seedPayoutStores, syncSystemRoles, upsertReportScope } from "@rueisiang/db";
import { cyberbizProducts, inventoryItems, payoutStores, productBundleComponents, productSkuMappings, reportSalesMonthly, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { cyberbizScopeIdFromStoreName } from "./cyberbiz-scope.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
const RANGE = { start: "2026-07-01", end: "2026-07-31" };

let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
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
    CYBERBIZ_SALES_WORKFLOW_FILE: "cyberbiz-sales-report.yml",
    CYBERBIZ_SALES_GITHUB_REF: "main",
  };
  await syncSystemRoles(db());
  await seedPayoutStores(db());
});

afterEach(() => vi.unstubAllGlobals());

describe("CYBERBIZ 商品銷售報表執行", () => {
  it("完整月份可由主管執行，並留下可匯入 D1 的 audit record", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const stores = await listPayoutStores(db());
    const names = stores.map((store) => store.name);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: names, ...RANGE }),
    });

    expect(response.status).toBe(202);
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining("/actions/workflows/cyberbiz-sales-report.yml/dispatches"),
      body: {
        ref: "main",
        inputs: { store: "全部", start: RANGE.start, end: RANGE.end },
      },
    });
    const [run] = await listCyberbizReportRuns(db(), "sales");
    expect(run).toMatchObject({ periodKind: "month", d1ImportEligible: 1, storesJson: JSON.stringify(names) });
  });

  it("自訂區間只記錄 Drive-only，不匯入 D1", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const store = (await listPayoutStores(db()))[0]!;
    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: [store.name], start: "2026-07-14", end: "2026-07-18" }),
    });

    expect(response.status).toBe(202);
    expect(calls[0]?.body).toMatchObject({ inputs: { store: store.name, start: "2026-07-14", end: "2026-07-18" } });
    const [run] = await listCyberbizReportRuns(db(), "sales");
    expect(run).toMatchObject({ periodKind: "custom", d1ImportEligible: 0 });
  });

  it("多家但不是全部時送出店名 JSON 陣列", async () => {
    const calls = stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const names = (await listPayoutStores(db())).slice(0, 2).map((store) => store.name);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: names, ...RANGE }),
    });

    expect(response.status).toBe(202);
    expect((calls[0]!.body as { inputs: { store: string } }).inputs.store).toBe(JSON.stringify(names));
  });

  it("關閉的店別不會出現在商品銷售執行頁，也不能被 API 繞過", async () => {
    const [hidden] = await listPayoutStores(db());
    await db().update(payoutStores).set({ enabled: false }).where(eq(payoutStores.id, hidden!.id));
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const state = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/state");
    const stateBody = (await state.json()) as { stores: { name: string }[] };
    expect(stateBody.stores.some((store) => store.name === hidden!.name)).toBe(false);

    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: [hidden!.name], ...RANGE }),
    });
    expect(response.status).toBe(400);
  });

  it("沒有商品銷售執行權限的人不能看到狀態或觸發 workflow", async () => {
    stubGithub();
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/tools/cyberbiz-sales/state");
    expect(response.status).toBe(403);
  });

  it("未設定 workflow 時回傳可理解的服務未設定狀態", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    env = { ...env, CYBERBIZ_SALES_WORKFLOW_FILE: undefined };
    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false });
  });

  it("sales repository 分開設定時，店別設定仍同步到兩個 repository", async () => {
    const calls = stubGithub();
    env = { ...env, CYBERBIZ_SALES_GITHUB_REPO: "ecotech-tw/report-runner", CYBERBIZ_SALES_GITHUB_REF: "release" };
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(id, "admin@ecotech.tw", "/api/tools/payout/stores", {
      method: "PUT",
      body: JSON.stringify({ stores: [{ name: "新店", driveFolderUrl: "https://drive.google.com/drive/folders/folder-id", driveFolderName: "新店" }] }),
    });

    expect(response.status).toBe(200);
    const writes = calls.filter((call) => call.url.includes("/contents/tools/cyberbiz-reports/stores.json"));
    expect(writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining("/repos/ecotech-tw/rueisiang-platform/"), body: expect.objectContaining({ branch: "main" }) }),
      expect.objectContaining({ url: expect.stringContaining("/repos/ecotech-tw/report-runner/"), body: expect.objectContaining({ branch: "release" }) }),
    ]));
  });

  it("商品銷售執行收到 null body 時回傳 400", async () => {
    stubGithub();
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: "null",
    });

    expect(response.status).toBe(400);
  });

  it("主管可以上傳完整月份的手動 sales，並沿用 CYBERBIZ 商品目錄", async () => {
    await db().insert(cyberbizProducts).values({
      sku: "MANUAL-001",
      productId: "manual-product-001",
      variantId: "manual-variant-001",
      productName: "手動商品",
      variantName: "",
    });
    const id = await seedUser("manager-sales@ecotech.tw", "role-manager");
    const response = await as(id, "manager-sales@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        scopeName: "手動測試店",
        reportMonth: "2026-07",
        rows: [{ sku: "MANUAL-001", grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 250 }],
      }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      kind: "sales",
      scopeId: expect.stringMatching(/^manual:store:/),
      scopeName: "手動測試店",
      reportMonth: "2026-07",
      rowCount: 1,
      skippedSkus: [],
    });
    const rows = await db().select().from(reportSalesMonthly);
    expect(rows).toEqual([expect.objectContaining({
      scopeId: expect.stringMatching(/^manual:store:/),
      reportMonth: "2026-07",
      sku: "MANUAL-001",
      productName: "手動商品",
      netQuantity: 2,
      salesAmount: 250,
    })]);
  });

  it("手動 sales 的外部 SKU 可以在同一個 scope 用 CYBERBIZ mapping 查回來", async () => {
    await db().insert(inventoryItems).values({
      id: "manual-query-item",
      sku: "SYSTEM-001",
      name: "系統商品",
      category: "未分類",
    });
    await db().insert(productSkuMappings).values({
      id: "manual-query-mapping",
      channel: "cyberbiz",
      externalName: "外部商品",
      externalSku: "EXTERNAL-001",
    });
    await db().insert(productBundleComponents).values({
      id: "manual-query-mapping:0",
      mappingId: "manual-query-mapping",
      inventoryItemId: "manual-query-item",
      customProductId: null,
      quantity: 1,
    });
    const id = await seedUser("manager-sales-query@ecotech.tw", "role-manager");
    const response = await as(id, "manager-sales-query@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        scopeName: "手動查詢店",
        reportMonth: "2026-07",
        rows: [{ sku: "EXTERNAL-001", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 200 }],
      }),
    });

    expect(response.status).toBe(201);
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeName: "手動查詢店",
      sku: "EXTERNAL-001",
    });
    expect(result.rows).toMatchObject([{ sku: "SYSTEM-001", netQuantity: 2 }]);
    expect(result.totals.netQuantity).toBe(2);
  });

  it("手動 sales 商品目錄沿用 sales 權限，供舊版合併檔補回 SKU", async () => {
    await db().insert(cyberbizProducts).values({
      sku: "LEGACY-001",
      productId: "legacy-product-001",
      variantId: "legacy-variant-001",
      productName: "舊檔商品",
      variantName: "",
      published: 0,
    });
    const manager = await seedUser("manager-manual-products@ecotech.tw", "role-manager");
    const response = await as(manager, "manager-manual-products@ecotech.tw", "/api/tools/manual-sales/products");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      products: expect.arrayContaining([{ sku: "LEGACY-001", name: "舊檔商品", published: false }]),
    });

    const viewer = await seedUser("viewer-manual-products@ecotech.tw", "role-viewer");
    expect((await as(viewer, "viewer-manual-products@ecotech.tw", "/api/tools/manual-sales/products")).status).toBe(403);
  });

  it("手動 sales 據點清單包含已設定店別，且檢視者不能使用匯入 API", async () => {
    const store = (await listPayoutStores(db()))[0]!;
    const manager = await seedUser("manager-manual-scopes@ecotech.tw", "role-manager");
    const response = await as(manager, "manager-manual-scopes@ecotech.tw", "/api/tools/manual-sales/scopes");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scopes: expect.arrayContaining([{ id: cyberbizScopeIdFromStoreName(store.name), name: store.name }]),
    });

    const viewer = await seedUser("viewer-manual-sales@ecotech.tw", "role-viewer");
    expect((await as(viewer, "viewer-manual-sales@ecotech.tw", "/api/tools/manual-sales/scopes")).status).toBe(403);
    expect((await as(viewer, "viewer-manual-sales@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({ scopeName: "不能匯入", reportMonth: "2026-07", rows: [] }),
    })).status).toBe(403);
  });

  it("手動 sales 不接受與檔案月份不一致的資料列", async () => {
    const id = await seedUser("manager-manual-validation@ecotech.tw", "role-manager");
    const response = await as(id, "manager-manual-validation@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        scopeName: "手動驗證店",
        reportMonth: "2026-07",
        rows: [{ sku: "MANUAL-001", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100, reportMonth: "2026-08" }],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("manual sales rejects scope IDs with mismatched names", async () => {
    await db().insert(cyberbizProducts).values({
      sku: "MISMATCH-001",
      productId: "mismatch-product-001",
      variantId: "mismatch-variant-001",
      productName: "驗證商品",
      variantName: "",
    });
    const id = await seedUser("manager-manual-scope-mismatch@ecotech.tw", "role-manager");
    const first = await as(id, "manager-manual-scope-mismatch@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        scopeName: "原本的店",
        reportMonth: "2026-07",
        rows: [{ sku: "MISMATCH-001", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100 }],
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { scopeId: string };

    const second = await as(id, "manager-manual-scope-mismatch@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        scopeId: firstBody.scopeId,
        scopeName: "不應被覆寫的店",
        reportMonth: "2026-07",
        rows: [{ sku: "MISMATCH-001", grossQuantity: 9, returnQuantity: 0, netQuantity: 9, salesAmount: 900 }],
      }),
    });
    expect(second.status).toBe(400);
    expect(await listReportScopes(db(), "store")).toEqual([
      expect.objectContaining({ id: firstBody.scopeId, name: "原本的店" }),
    ]);
    expect((await db().select().from(reportSalesMonthly)).map((row) => row.netQuantity)).toEqual([1]);
  });
  it("新建據點名稱撞到既有據點時擋下來，不會覆寫那家店當月的匯入資料", async () => {
    await db().insert(cyberbizProducts).values({
      sku: "COLLIDE-001",
      productId: "collide-product-001",
      variantId: "collide-variant-001",
      productName: "撞名商品",
      variantName: "",
    });
    const importedScopeId = cyberbizScopeIdFromStoreName("中友百貨");
    await upsertReportScope(db(), { id: importedScopeId, scopeKind: "store", name: "中友百貨" });
    await insertReportSalesMonthly(db(), [{
      scopeId: importedScopeId,
      reportMonth: "2026-07",
      sku: "COLLIDE-001",
      productName: "撞名商品",
      category: "未分類",
      grossQuantity: 5,
      returnQuantity: 0,
      netQuantity: 5,
      salesAmount: 99999,
    }]);

    const id = await seedUser("manager-manual-collide@ecotech.tw", "role-manager");
    const response = await as(id, "manager-manual-collide@ecotech.tw", "/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify({
        scopeName: "中友百貨",
        reportMonth: "2026-07",
        rows: [{ sku: "COLLIDE-001", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 0 }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("已經有名為「中友百貨」的據點") });
    expect(await listReportScopes(db(), "store")).toEqual([expect.objectContaining({ id: importedScopeId })]);
    expect((await db().select().from(reportSalesMonthly)).map((row) => [row.scopeId, row.salesAmount])).toEqual([
      [importedScopeId, 99999],
    ]);
  });
});
