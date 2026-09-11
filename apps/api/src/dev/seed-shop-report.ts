/**
 * 把一份真的官網對帳表灌進本機 local.sqlite，用來眼睛看半月匯入的行為。
 *
 * 只給本機開發用，不會進 Worker 打包（src/dev 整個目錄都被 tsconfig 排除）。
 *
 *   pnpm --filter @rueisiang/api exec tsx src/dev/seed-shop-report.ts <xlsx 路徑>...
 */
import { createDatabase, insertReportPayoutDaily, insertReportSalesPeriod, upsertReportScope } from "@rueisiang/db";
import { reportItemSalesMonthly, reportItemSalesPeriod, items } from "@rueisiang/db/schema";
import { and, eq } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTargetOnlyD1 } from "../local-d1/d1.js";
// tools/ 刻意不在 pnpm workspace 裡，所以走相對路徑載入 parser。
import { parseShopReport } from "../../../../tools/cyberbiz-reports/shop/parser.mjs";

const SHOP_SCOPE_ID = "cyberbiz:channel:shop";
const files = process.argv.slice(2);
if (!files.length) throw new Error("請給至少一個對帳表路徑。");

// dev server 用的是 target-only 模式，種子也要走同一條，不然 schema 會不一樣。
// 路徑跟著模組算，不要用相對於 cwd 的字串——pnpm --filter 執行時 cwd 是 apps/api，
// 「apps/api/local.sqlite」會變成 apps/api/apps/api/local.sqlite，而且不會報錯，
// 只是資料寫進一個沒有人會讀的檔案。
const DB_FILE = path.resolve(process.env.DEV_DB_FILE?.trim() || path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../local.sqlite"));
const d1 = createTargetOnlyD1(DB_FILE);
console.log(`資料庫：${DB_FILE}`);
const db = createDatabase(d1 as never);

await upsertReportScope(db, { id: SHOP_SCOPE_ID, scopeKind: "channel", name: "官網", sourceType: "cyberbiz" });

for (const file of files) {
  const report = await parseShopReport(file);
  const result = await insertReportSalesPeriod(db, {
    scopeId: SHOP_SCOPE_ID,
    periodStart: report.period.start,
    periodEnd: report.period.end,
    rows: report.items.map((item) => ({
      sku: item.sku,
      productName: item.productName,
      category: item.category,
      grossQuantity: item.quantity,
      netQuantity: item.quantity,
      salesAmount: item.salesAmount,
    })),
  });
  // 撥款記在期末那一天：官網是半月結算，沒有逐日的撥款可以記。
  await insertReportPayoutDaily(db, [{
    scopeId: SHOP_SCOPE_ID,
    businessDate: report.period.end,
    payoutAmount: report.settlementAmount,
  }]);
  console.log(`匯入 ${report.period.start} ~ ${report.period.end}：${result.itemCount} 個 SKU、營業額 ${result.salesAmount}、撥款 ${report.settlementAmount}`);
}

const monthly = await db.select({
  reportMonth: reportItemSalesMonthly.reportMonth,
  sku: items.sku,
  netQuantity: reportItemSalesMonthly.netQuantity,
  salesAmount: reportItemSalesMonthly.salesAmount,
}).from(reportItemSalesMonthly)
  .innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId))
  .where(eq(reportItemSalesMonthly.scopeId, SHOP_SCOPE_ID));

const periods = await db.selectDistinct({
  periodStart: reportItemSalesPeriod.periodStart,
  periodEnd: reportItemSalesPeriod.periodEnd,
}).from(reportItemSalesPeriod).where(eq(reportItemSalesPeriod.scopeId, SHOP_SCOPE_ID));

console.log(`\n期間列：${periods.map((p) => `${p.periodStart}~${p.periodEnd}`).join("、")}`);
console.log(`月報：${monthly.length} 個 SKU、${monthly.reduce((sum, row) => sum + row.netQuantity, 0)} 件、${monthly.reduce((sum, row) => sum + row.salesAmount, 0)} 元`);

const payout = await db.select({ businessDate: reportItemSalesMonthly.reportMonth }).from(reportItemSalesMonthly)
  .where(and(eq(reportItemSalesMonthly.scopeId, SHOP_SCOPE_ID), eq(reportItemSalesMonthly.recordOrigin, "imported")))
  .limit(1);
if (!payout.length) console.log("（月報是空的，檢查匯入是否失敗）");
d1.sqlite.close();
