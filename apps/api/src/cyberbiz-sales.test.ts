import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, insertReportSalesMonthly, listCyberbizReportRuns, listPayoutStores, seedPayoutStores, syncSystemRoles, upsertReportScope } from "@rueisiang/db";
import { items, reportItemSalesMonthly, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { cyberbizScopeIdFromStoreName, manualScopeIdFromStoreName } from "./cyberbiz-scope.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
const RANGE = { start: "2026-07-01", end: "2026-07-31" };

let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function reportSalesRows() {
  return db().select({
    scopeId: reportItemSalesMonthly.scopeId,
    reportMonth: reportItemSalesMonthly.reportMonth,
    sku: items.sku,
    productName: items.name,
    netQuantity: reportItemSalesMonthly.netQuantity,
    salesAmount: reportItemSalesMonthly.salesAmount,
  }).from(reportItemSalesMonthly).innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId));
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
    await db().update(scopes).set({ active: 0 }).where(eq(scopes.id, hidden!.id));
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

  it("店別設定跟著這次執行送給 runner，含 scopeId 與 Drive 資料夾", async () => {
    const calls = stubGithub();
    env = { ...env, CYBERBIZ_SALES_GITHUB_REPO: "ecotech-tw/report-runner", CYBERBIZ_SALES_GITHUB_REF: "release" };
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    await as(id, "manager@ecotech.tw", "/api/tools/cyberbiz-sales/run", {
      method: "POST",
      body: JSON.stringify({ stores: ["宏匯廣場1F"], start: "2026-07-01", end: "2026-07-31" }),
    });

    // 舊版是把清單 commit 成兩個 repository 的 stores.json；現在跟著 dispatch 走。
    const dispatch = calls[0]!;
    expect(dispatch.url).toContain("/repos/ecotech-tw/report-runner/");
    const sent = JSON.parse((dispatch.body as { inputs: { stores_json: string } }).inputs.stores_json) as { name: string; scopeId: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "宏匯廣場1F", scopeId: cyberbizScopeIdFromStoreName("宏匯廣場1F") });
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

  /*
   * 人工匯入原本有兩組實作：tools 的 /manual-sales 與報表管理的
   * /api/reports/cyberbiz/manual/import/sales。前者沒有任何前端呼叫端，這一輪移除。
   *
   * 兩邊都要求資料列自己帶 SKU（/manual-sales/products 只是把 CYBERBIZ 目錄丟給
   * 瀏覽器，名稱對 SKU 是在前端做的），所以移除不會少掉伺服器端的能力。下面幾條
   * 是原本只有舊那組在守、值得留下來的保護，改釘在活著的那一條上。
   */
  const SALES_IMPORT = "/api/reports/cyberbiz/manual/import/sales";

  it("對應不到的 SKU 會被略過並回報，不會靜靜當成賣了 0 個", async () => {
    const manager = await seedUser("manager-sales@ecotech.tw", "role-manager");
    const response = await as(manager, "manager-sales@ecotech.tw", SALES_IMPORT, {
      method: "POST",
      body: JSON.stringify({
        scopeName: "手動店",
        reportMonth: "2026-07",
        rows: [{ sku: "SKU-1", productName: "商品一", category: "食品", grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 200 }],
      }),
    });

    expect(response.status).toBe(201);
    // 沒有對應的 SKU 不會寫進報表，但要出現在 skippedSkus——不然那些銷售會安靜消失。
    expect(await response.json()).toMatchObject({
      scopeName: "手動店",
      reportMonth: "2026-07",
      skippedSkus: ["SKU-1"],
      totals: { netQuantity: 0, salesAmount: 0 },
    });
    expect(await reportSalesRows()).toHaveLength(0);
  });

  it("新建據點名稱撞到既有據點時擋下來，不會覆寫那家店當月的匯入資料", async () => {
    await upsertReportScope(db(), { id: "cyberbiz:store:existing", scopeKind: "store", name: "中友百貨" });
    await insertReportSalesMonthly(db(), [{
      scopeId: "cyberbiz:store:existing", reportMonth: "2026-07", sku: "SKU-KEEP",
      productName: "既有商品", category: "食品", grossQuantity: 9, returnQuantity: 0, netQuantity: 9, salesAmount: 900,
    }]);
    const manager = await seedUser("manager-sales-dup@ecotech.tw", "role-manager");

    const response = await as(manager, "manager-sales-dup@ecotech.tw", SALES_IMPORT, {
      method: "POST",
      body: JSON.stringify({
        scopeName: "中友百貨",
        reportMonth: "2026-07",
        rows: [{ sku: "SKU-NEW", productName: "新商品", category: "食品", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100 }],
      }),
    });

    expect(response.status).toBe(409);
    expect((await db().select().from(scopes)).map((scope) => scope.id)).not.toContain(manualScopeIdFromStoreName("中友百貨"));
    expect(await reportSalesRows()).toMatchObject([{ sku: "SKU-KEEP", netQuantity: 9 }]);
  });

  it("同一個 SKU 加總後超出安全整數範圍時整份擋下來", async () => {
    const manager = await seedUser("manager-sales-overflow@ecotech.tw", "role-manager");
    const response = await as(manager, "manager-sales-overflow@ecotech.tw", SALES_IMPORT, {
      method: "POST",
      body: JSON.stringify({
        scopeName: "手動店",
        reportMonth: "2026-07",
        rows: [
          { sku: "SKU-1", productName: "商品一", category: "食品", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: Number.MAX_SAFE_INTEGER },
          { sku: "SKU-1", productName: "商品一", category: "食品", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 1 },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await reportSalesRows()).toHaveLength(0);
  });

  it("檢視者不能匯入", async () => {
    const viewer = await seedUser("viewer-manual-sales@ecotech.tw", "role-viewer");
    const response = await as(viewer, "viewer-manual-sales@ecotech.tw", SALES_IMPORT, {
      method: "POST",
      body: JSON.stringify({ scopeName: "手動店", reportMonth: "2026-07", rows: [] }),
    });

    expect(response.status).toBe(403);
    expect(await reportSalesRows()).toHaveLength(0);
  });

  it("報表月份格式不對就擋下來", async () => {
    const manager = await seedUser("manager-sales-month@ecotech.tw", "role-manager");
    const response = await as(manager, "manager-sales-month@ecotech.tw", SALES_IMPORT, {
      method: "POST",
      body: JSON.stringify({
        scopeName: "手動店",
        reportMonth: "2026-13",
        rows: [{ sku: "SKU-1", productName: "商品一", category: "食品", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100 }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await reportSalesRows()).toHaveLength(0);
  });
});
