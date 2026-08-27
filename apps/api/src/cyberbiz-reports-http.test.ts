import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  createDatabase,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  syncSystemRoles,
  upsertReportScope,
} from "@rueisiang/db";
import { userRoles, users } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
const WEST = "cyberbiz:store:西門3F";
const SHOPEE = "shopee:store:default";

let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId?: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  if (roleId) await db().insert(userRoles).values({ userId: id, roleId });
  return { id, email };
}

async function get(user: { id: string; email: string }, path: string) {
  const token = await signSession(
    newSessionClaims({ id: user.id, email: user.email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://platform.rueisiang.com${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }),
    env as never,
  );
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(db());
  await upsertReportScope(db(), { id: WEST, scopeKind: "store", name: "誠品西門店 3F" });
  await upsertReportScope(db(), { id: SHOPEE, scopeKind: "store", name: "蝦皮商城" });
  await insertReportSalesMonthly(db(), [
    { scopeId: WEST, reportMonth: "2026-07", sku: "SKU-1", productName: "洗髮精", category: "沐浴", grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 },
    { scopeId: SHOPEE, reportMonth: "2026-07", sku: "SKU-9", productName: "蝦皮限定組", category: "組合", grossQuantity: 10, returnQuantity: 0, netQuantity: 10, salesAmount: 1000 },
  ]);
  await insertReportPayoutDaily(db(), [
    { scopeId: WEST, businessDate: "2026-07-01", payoutAmount: 1000 },
    { scopeId: SHOPEE, businessDate: "2026-07-02", payoutAmount: 5000 },
  ]);
});

describe("報表檢視的 HTTP 端點", () => {
  it("未登入是 401，沒有權限是 403", async () => {
    const anonymous = await app.fetch(
      new Request("https://platform.rueisiang.com/api/reports/cyberbiz/scopes"),
      env as never,
    );
    expect(anonymous.status).toBe(401);

    const nobody = await seedUser("none@ecotech.tw");
    expect((await get(nobody, "/api/reports/cyberbiz/scopes")).status).toBe(403);
  });

  it("店別清單含其他通路的據點，讓報表頁的下拉選得到蝦皮", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await get(manager, "/api/reports/cyberbiz/scopes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scopes: [{ id: SHOPEE, name: "蝦皮商城" }, { id: WEST, name: "誠品西門店 3F" }],
    });
  });

  it("全公司查詢把蝦皮一起算進來", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const sales = await get(manager, "/api/reports/cyberbiz/sales?startDate=2026-07-01&endDate=2026-07-31&scopeType=company&groupBy=month,scope");
    expect(sales.status).toBe(200);
    expect((await sales.json() as { totals: unknown }).totals)
      .toEqual({ grossQuantity: 15, returnQuantity: 1, netQuantity: 14, salesAmount: 1380 });

    const payout = await get(manager, "/api/reports/cyberbiz/payout?startDate=2026-07-01&endDate=2026-07-31&scopeType=company&groupBy=month,scope");
    expect((await payout.json() as { totals: unknown }).totals).toEqual({ payoutAmount: 6000 });
  });

  it("依商品分組會同時帶出 SKU、商品名稱與分類", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await get(manager, "/api/reports/cyberbiz/sales?startDate=2026-07-01&endDate=2026-07-31&scopeType=store&scopeId=" + encodeURIComponent(WEST) + "&groupBy=sku,product,category");
    expect(response.status).toBe(200);
    expect((await response.json() as { rows: unknown[] }).rows).toEqual([
      expect.objectContaining({ sku: "SKU-1", productName: "洗髮精", category: "沐浴", netQuantity: 4, salesAmount: 380 }),
    ]);
  });

  it("不認得的 groupBy 會被擋成 400", async () => {
    const manager = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await get(manager, "/api/reports/cyberbiz/sales?startDate=2026-07-01&endDate=2026-07-31&scopeType=company&groupBy=day");
    expect(response.status).toBe(400);
  });
});
