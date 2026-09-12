import {
  insertReportPayoutDaily,
  insertReportSalesPeriod,
  upsertReportScope,
  type NewReportSalesPeriodRow,
} from "@rueisiang/db";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createCyberbizReportIngestor, CyberbizReportIngestError } from "../cyberbiz-report-ingest.js";
import { forgetReportAnalytics } from "../report-cache.js";
import { cacheClient } from "../upstash.js";

const INGEST_TOKEN_HEADER = "x-cyberbiz-report-token";

async function sameSecret(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function statementInput(value: unknown): {
  scopeId: string;
  scopeName: string;
  periodStart: string;
  periodEnd: string;
  settlementAmount: number;
  rows: NewReportSalesPeriodRow[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  const body = value as Record<string, unknown>;
  const string = (key: string) => {
    const text = typeof body[key] === "string" ? (body[key] as string).trim() : "";
    if (!text) throw new CyberbizReportIngestError(422, "invalid_ingest", `${key} 是必填。`);
    return text;
  };
  const date = (key: string) => {
    const text = string(key);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new CyberbizReportIngestError(422, "invalid_ingest", `${key} 必須是 YYYY-MM-DD。`);
    return text;
  };
  const integer = (raw: unknown, label: string) => {
    const parsed = Math.round(Number(raw ?? 0));
    if (!Number.isSafeInteger(parsed)) throw new CyberbizReportIngestError(422, "invalid_ingest", `${label} 不是安全整數。`);
    return parsed;
  };

  const periodStart = date("periodStart");
  const periodEnd = date("periodEnd");
  if (periodEnd < periodStart) throw new CyberbizReportIngestError(422, "invalid_ingest", "periodEnd 早於 periodStart。");
  // 跨月在這裡擋掉。不擋的話會一路走到 insertReportSalesPeriod 丟一個普通 Error，
  // route 的 catch 認不得就變成 500——呼叫端看不出是自己送錯東西還是平台壞了。
  if (periodStart.slice(0, 7) !== periodEnd.slice(0, 7)) {
    throw new CyberbizReportIngestError(422, "invalid_ingest", `期間跨月無法併入月報：${periodStart} ~ ${periodEnd}`);
  }
  if (!Array.isArray(body.rows)) {
    throw new CyberbizReportIngestError(422, "invalid_ingest", "rows 是必填。");
  }

  const rows = body.rows.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CyberbizReportIngestError(422, "invalid_ingest", `第 ${index + 1} 列格式不正確。`);
    }
    const row = raw as Record<string, unknown>;
    const sku = typeof row.sku === "string" ? row.sku.trim() : "";
    if (!sku) throw new CyberbizReportIngestError(422, "invalid_ingest", `第 ${index + 1} 列缺少 SKU。`);
    const quantity = integer(row.quantity ?? row.netQuantity, `第 ${index + 1} 列數量`);
    return {
      sku,
      productName: typeof row.productName === "string" ? row.productName : undefined,
      category: typeof row.category === "string" ? row.category : undefined,
      grossQuantity: quantity,
      netQuantity: quantity,
      salesAmount: integer(row.salesAmount, `第 ${index + 1} 列金額`),
    };
  });

  return {
    scopeId: string("scopeId"),
    scopeName: string("scopeName"),
    periodStart,
    periodEnd,
    settlementAmount: integer(body.settlementAmount, "撥款金額"),
    rows,
  };
}

export const cyberbizReportsInternal = new Hono<AppEnv>()
  /**
   * 官網對帳單（管理中心 → 對帳中心）。
   *
   * 沒有走上面那條 /ingest：那條是「一個月一份」的語意，而對帳單是 CYBERBIZ 每半個月
   * 自己出的，一個月兩份。期間的儲存與月加總在 insertReportSalesPeriod 裡，理由見那裡。
   *
   * SKU 走自動建品項那條路（跟人工匯入一致），不是 report_external_products 的顯式
   * 對應：官網商品的 SKU 本來就在 items 裡（官網商品同步建的），對得到；對不到的只有
   * 運費這種收費列，而那正是我們要它自己建起來的。
   */
  .post("/shop-statement", async (c) => {
    if (!await sameSecret(c.req.header(INGEST_TOKEN_HEADER), c.env.CYBERBIZ_REPORT_INGEST_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      const input = statementInput(await c.req.json<unknown>().catch(() => {
        throw new CyberbizReportIngestError(422, "invalid_ingest");
      }));
      const db = c.get("db");
      await upsertReportScope(db, {
        id: input.scopeId,
        // 官網不是櫃點，是通路：這樣它就不會出現在出金表／商品銷售的店別清單與
        // HR 的據點清單裡（那些都只挑 store），但營運統計與公司總額照樣算得到。
        scopeKind: "channel",
        name: input.scopeName,
        sourceType: "cyberbiz",
      });
      const sales = await insertReportSalesPeriod(db, {
        scopeId: input.scopeId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        rows: input.rows,
      });
      // 撥款記在期末那一天：官網是半月結算，沒有逐日的撥款可以記。
      await insertReportPayoutDaily(db, [{
        scopeId: input.scopeId,
        businessDate: input.periodEnd,
        payoutAmount: input.settlementAmount,
      }]);
      return c.json({ result: { scopeId: input.scopeId, ...sales, settlementAmount: input.settlementAmount } }, 200);
    } catch (error) {
      if (error instanceof CyberbizReportIngestError) return c.json({ error: error.code, message: error.message }, error.status);
      throw error;
    } finally {
      await forgetReportAnalytics(cacheClient(c.env));
    }
  })

  .post("/ingest", async (c) => {
    if (!await sameSecret(c.req.header(INGEST_TOKEN_HEADER), c.env.CYBERBIZ_REPORT_INGEST_TOKEN)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      let body: unknown;
      try {
        body = await c.req.json<unknown>();
      } catch {
        throw new CyberbizReportIngestError(422, "invalid_ingest");
      }
      const result = await createCyberbizReportIngestor(c.get("db")).ingest(body);
      return c.json({ result }, 200);
    } catch (error) {
      if (error instanceof CyberbizReportIngestError) return c.json({ error: error.code, message: error.message }, error.status);
      throw error;
    } finally {
      // ingest 可能已先寫入 scope 或部分批次後才失敗；成功與失敗都要清掉報表快取。
      await forgetReportAnalytics(cacheClient(c.env));
    }
  });
