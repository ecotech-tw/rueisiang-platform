import { createDatabase, insertReportSalesPeriod, upsertReportScope } from "@rueisiang/db";
import { reportItemSalesMonthly, reportItemSalesPeriod, items } from "@rueisiang/db/schema";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

/*
 * 官網對帳表是 CYBERBIZ 每半個月自動出的，區間不能自己選，所以一個月兩份檔案。
 * 月報的主鍵沒有期間，這幾條就是在守「兩份會相加、重傳不會加兩遍」。
 */

const SCOPE = "cyberbiz:channel:shop";
let d1: ReturnType<typeof createTargetOnlyD1>;
let db: ReturnType<typeof createDatabase>;

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
  await upsertReportScope(db, { id: SCOPE, scopeKind: "channel", name: "官網", sourceType: "cyberbiz" });
});

async function monthly() {
  const rows = await db.select({
    sku: items.sku,
    reportMonth: reportItemSalesMonthly.reportMonth,
    netQuantity: reportItemSalesMonthly.netQuantity,
    salesAmount: reportItemSalesMonthly.salesAmount,
  }).from(reportItemSalesMonthly).innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId));
  return rows.sort((left, right) => left.sku.localeCompare(right.sku));
}

const firstHalf = {
  scopeId: SCOPE,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-15",
  rows: [
    { sku: "SKU-A", productName: "商品甲", grossQuantity: 2, netQuantity: 2, salesAmount: 200 },
    { sku: "SKU-B", productName: "商品乙", grossQuantity: 1, netQuantity: 1, salesAmount: 100 },
  ],
};

const secondHalf = {
  scopeId: SCOPE,
  periodStart: "2026-08-16",
  periodEnd: "2026-08-31",
  rows: [
    { sku: "SKU-A", productName: "商品甲", grossQuantity: 3, netQuantity: 3, salesAmount: 300 },
    { sku: "CYBERBIZ-CHARGE-運費", productName: "運費", grossQuantity: 1, netQuantity: 1, salesAmount: 50 },
  ],
};

describe("官網半月對帳表匯入", () => {
  it("兩份半月檔會相加，不會互相覆蓋", async () => {
    await insertReportSalesPeriod(db, firstHalf);
    expect(await monthly()).toMatchObject([
      { sku: "SKU-A", reportMonth: "2026-08", netQuantity: 2, salesAmount: 200 },
      { sku: "SKU-B", reportMonth: "2026-08", netQuantity: 1, salesAmount: 100 },
    ]);

    await insertReportSalesPeriod(db, secondHalf);
    expect(await monthly()).toMatchObject([
      { sku: "CYBERBIZ-CHARGE-運費", netQuantity: 1, salesAmount: 50 },
      { sku: "SKU-A", netQuantity: 5, salesAmount: 500 },
      { sku: "SKU-B", netQuantity: 1, salesAmount: 100 },
    ]);
  });

  it("同一份重傳兩次的結果跟傳一次一樣", async () => {
    await insertReportSalesPeriod(db, firstHalf);
    await insertReportSalesPeriod(db, secondHalf);
    const once = await monthly();

    await insertReportSalesPeriod(db, secondHalf);
    expect(await monthly()).toEqual(once);
  });

  it("重傳的內容變了就換掉那一期，不是疊上去", async () => {
    await insertReportSalesPeriod(db, firstHalf);
    await insertReportSalesPeriod(db, secondHalf);

    // 下半月更正成只有一筆，而且 SKU-A 的數字改了。
    await insertReportSalesPeriod(db, {
      ...secondHalf,
      rows: [{ sku: "SKU-A", productName: "商品甲", grossQuantity: 1, netQuantity: 1, salesAmount: 99 }],
    });

    expect(await monthly()).toMatchObject([
      // 運費那一列在更正後的檔案裡不見了，月報也要跟著不見——
      // 逐列 upsert 會把它留在月報上，變成一筆憑空多出來的錢。
      { sku: "SKU-A", netQuantity: 3, salesAmount: 299 },
      { sku: "SKU-B", netQuantity: 1, salesAmount: 100 },
    ]);
  });

  it("不同月份互不影響", async () => {
    await insertReportSalesPeriod(db, secondHalf);
    await insertReportSalesPeriod(db, {
      scopeId: SCOPE,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      rows: [{ sku: "SKU-A", productName: "商品甲", grossQuantity: 7, netQuantity: 7, salesAmount: 700 }],
    });

    const rows = await monthly();
    expect(rows.filter((row) => row.reportMonth === "2026-08").map((row) => row.salesAmount).reduce((a, b) => a + b, 0)).toBe(350);
    expect(rows.filter((row) => row.reportMonth === "2026-09")).toMatchObject([{ sku: "SKU-A", salesAmount: 700 }]);
  });

  it("期間跨月直接拒絕——月報會把兩個月混在一起", async () => {
    await expect(insertReportSalesPeriod(db, {
      ...firstHalf,
      periodStart: "2026-08-16",
      periodEnd: "2026-09-15",
    })).rejects.toThrow(/期間跨月/);
    expect(await monthly()).toEqual([]);
  });

  it("沒見過的 SKU 會自動建成自訂品項，運費才進得了報表", async () => {
    await insertReportSalesPeriod(db, secondHalf);
    const [shipping] = await db.select({ sku: items.sku, name: items.name, source: items.source })
      .from(items).where(eq(items.sku, "CYBERBIZ-CHARGE-運費"));
    expect(shipping).toMatchObject({ name: "運費", source: "custom" });
  });

  it("期間列自己也留著，月報是它的加總", async () => {
    await insertReportSalesPeriod(db, firstHalf);
    await insertReportSalesPeriod(db, secondHalf);
    const periods = await db.select({ periodStart: reportItemSalesPeriod.periodStart, salesAmount: reportItemSalesPeriod.salesAmount })
      .from(reportItemSalesPeriod)
      .where(and(eq(reportItemSalesPeriod.scopeId, SCOPE), eq(reportItemSalesPeriod.reportMonth, "2026-08")));
    expect(periods).toHaveLength(4);
    expect(periods.reduce((sum, row) => sum + row.salesAmount, 0)).toBe(650);
  });

  it("大小寫不同的同一個 SKU 會合併相加，不會撞主鍵也不會少算", async () => {
    // SKU 是用小寫比對解析到品項的，所以這兩列是同一個 item。不先合併的話，
    // 逐列 insert 會撞 (scope, 期間, item) 主鍵讓整期匯入失敗。
    await insertReportSalesPeriod(db, {
      scopeId: SCOPE,
      periodStart: "2026-08-01",
      periodEnd: "2026-08-15",
      rows: [
        { sku: "SKU-A", productName: "商品甲", grossQuantity: 2, netQuantity: 2, salesAmount: 200 },
        { sku: "sku-a", productName: "商品甲", grossQuantity: 1, netQuantity: 1, salesAmount: 100 },
      ],
    });

    const periods = await db.select({ netQuantity: reportItemSalesPeriod.netQuantity, salesAmount: reportItemSalesPeriod.salesAmount })
      .from(reportItemSalesPeriod).where(eq(reportItemSalesPeriod.scopeId, SCOPE));
    expect(periods).toEqual([{ netQuantity: 3, salesAmount: 300 }]);
    expect(await monthly()).toMatchObject([{ sku: "SKU-A", netQuantity: 3, salesAmount: 300 }]);
  });

  it("跨月的期間不匯入，月加總不能把兩個月混在一起", async () => {
    await expect(insertReportSalesPeriod(db, {
      scopeId: SCOPE,
      periodStart: "2026-08-16",
      periodEnd: "2026-09-15",
      rows: [{ sku: "SKU-A", productName: "商品甲", grossQuantity: 1, netQuantity: 1, salesAmount: 100 }],
    })).rejects.toThrow(/跨月/);
  });
});
