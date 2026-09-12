import { createDatabase } from "@rueisiang/db";
import { items, reportItemSalesMonthly, reportPayoutDaily, scopes } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

/*
 * runner 把對帳單送回平台的那條路。它不走 /ingest——那條是「一個月一份」的語意，
 * 對帳單是半月一份。這幾條守的是「送錯東西要說得出是哪裡錯」，而不是回 500。
 */

const TOKEN = "ingest-token";
const SCOPE = "cyberbiz:channel:shop";

let d1: ReturnType<typeof createTargetOnlyD1>;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function post(body: unknown, token = TOKEN) {
  return app.fetch(
    new Request("https://platform.rueisiang.com/api/internal/cyberbiz-reports/shop-statement", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cyberbiz-report-token": token },
      body: JSON.stringify(body),
    }),
    env as never,
  );
}

const statement = {
  scopeId: SCOPE,
  scopeName: "官網",
  periodStart: "2026-08-16",
  periodEnd: "2026-08-31",
  settlementAmount: 64559,
  rows: [
    { sku: "SKU-A", productName: "商品甲", quantity: 2, salesAmount: 200 },
    { sku: "CYBERBIZ-CHARGE-運費", productName: "運費", quantity: 1, salesAmount: 50 },
  ],
};

beforeEach(() => {
  // target-only：createLocalD1 是舊 schema，report_payout_daily 還沒有 record_origin。
  d1 = createTargetOnlyD1();
  env = { DB: d1, AUTH_SESSION_SECRET: "s", GOOGLE_OAUTH_CLIENT_ID: "c", GOOGLE_OAUTH_CLIENT_SECRET: "s", CYBERBIZ_REPORT_INGEST_TOKEN: TOKEN };
});

describe("官網對帳單匯入", () => {
  it("匯入之後商品銷售與撥款都進得去，而且官網是 channel 不是櫃點", async () => {
    const response = await post(statement);
    expect(response.status).toBe(200);

    const [scope] = await db().select().from(scopes).where(eq(scopes.id, SCOPE));
    expect(scope).toMatchObject({ scopeKind: "channel", sourceType: "cyberbiz", name: "官網" });

    const sales = await db().select({ sku: items.sku, salesAmount: reportItemSalesMonthly.salesAmount })
      .from(reportItemSalesMonthly).innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId));
    expect(sales.reduce((sum, row) => sum + row.salesAmount, 0)).toBe(250);

    // 撥款記在期末那一天：官網是半月結算，沒有逐日的撥款可以記。
    const payout = await db().select().from(reportPayoutDaily);
    expect(payout).toMatchObject([{ businessDate: "2026-08-31", payoutAmount: 64559 }]);
  });

  it("token 不對就回 401，什麼都不寫", async () => {
    const response = await post(statement, "wrong");
    expect(response.status).toBe(401);
    expect(await db().select().from(scopes).where(eq(scopes.id, SCOPE))).toHaveLength(0);
  });

  it("跨月的期間回 422 而不是 500", async () => {
    // 不擋的話會一路走到 insertReportSalesPeriod 丟普通 Error，route 認不得就變 500，
    // 呼叫端看不出是自己送錯還是平台壞了。
    const response = await post({ ...statement, periodStart: "2026-08-16", periodEnd: "2026-09-15" });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_ingest", message: expect.stringContaining("跨月") });
  });

  it("缺欄位與日期格式錯回 422；空白期間可用零列匯入", async () => {
    const { scopeName: _scopeName, ...noName } = statement;
    expect((await post(noName)).status).toBe(422);
    expect((await post({ ...statement, periodStart: "2026-8-16" })).status).toBe(422);
    const empty = await post({ ...statement, periodStart: "2026-08-01", periodEnd: "2026-08-15", settlementAmount: -7, rows: [] });
    expect(empty.status).toBe(200);
    expect((await db().select().from(reportItemSalesMonthly))).toHaveLength(0);
    expect(await db().select({ businessDate: reportPayoutDaily.businessDate, payoutAmount: reportPayoutDaily.payoutAmount }).from(reportPayoutDaily))
      .toMatchObject([{ businessDate: "2026-08-15", payoutAmount: -7 }]);
    expect((await post({ ...statement, rows: [{ productName: "沒有 SKU", quantity: 1, salesAmount: 10 }] })).status).toBe(422);
  });
});
