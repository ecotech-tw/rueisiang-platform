import {
  buildReportComparisonRanges,
  calculateGrowth,
  createDatabase,
  createReportScopeDirectory,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  parseReportRange,
  queryReportPayoutSummary,
  queryReportSalesSummary,
  upsertReportScope,
  type ReportAnalyticsRange,
} from "@rueisiang/db";
import { itemCategories } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;
function db() { return createDatabase(d1 as never); }

/**
 * 數這次統計對 report_scopes 發了幾次查詢。
 *
 * 一份統計會呼叫底層查詢七、八次，每一次原本都要讀兩遍店別名冊（解析 scope id
 * 一次、把 id 換成店名一次）。那是十幾趟往返讀同一張只有幾列的表，而 D1 免費
 * 方案是「每次 Worker 呼叫最多 50 個查詢」。
 */
function countScopeReads(target: LocalD1) {
  let reads = 0;
  const spy = {
    prepare(query: string) {
      if (query.includes("scopes")) reads += 1;
      return target.prepare(query);
    },
    batch: (statements: never) => target.batch(statements),
    exec: (query: string) => target.exec(query),
  };
  return { spy, reads: () => reads };
}

const WEST = "cyberbiz:store:西門3F";
const EAST = "cyberbiz:store:信義2F";

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await upsertReportScope(db(), { id: WEST, scopeKind: "store", name: "誠品西門店 3F" });
  await upsertReportScope(db(), { id: EAST, scopeKind: "store", name: "誠品信義店 2F" });
  await db().insert(itemCategories).values([
    { id: "cat-bath", depth: 0, parentId: null, parentDepth: null, name: "沐浴", color: "rose", sortOrder: 0, active: 1 },
    { id: "cat-food", depth: 0, parentId: null, parentDepth: null, name: "食品", color: "rose", sortOrder: 1, active: 1 },
  ]);
});

describe("店別名冊", () => {
  it("以 id 或名稱解析，查不到回 null，同名回報 ambiguous", async () => {
    const directory = createReportScopeDirectory(db());

    expect(await directory.store({ id: WEST })).toMatchObject({ id: WEST });
    expect(await directory.store({ name: "誠品西門店 3F" })).toMatchObject({ id: WEST });
    // 名稱比對會忽略空白與大小寫，跟 findReportScope 一致。
    expect(await directory.store({ name: "誠品西門店3f" })).toMatchObject({ id: WEST });
    expect(await directory.store({ id: "cyberbiz:store:不存在" })).toBeNull();
    expect(await directory.store({})).toBeNull();

    await upsertReportScope(db(), { id: "shopee:store:西門3F備份", scopeKind: "store", name: "誠品西門店 3F", sourceType: "shopee" });
    await expect(createReportScopeDirectory(db()).store({ name: "誠品西門店 3F" })).rejects.toThrow(/對應到多個/u);
  });

  it("查詢失敗不會被記住，同一份名冊仍然可以重試", async () => {
    let attempts = 0;
    const flaky = {
      prepare(query: string) {
        if (query.includes("scopes")) {
          attempts += 1;
          if (attempts === 1) throw new Error("D1 暫時性錯誤");
        }
        return d1.prepare(query);
      },
      batch: (statements: never) => d1.batch(statements),
      exec: (query: string) => d1.exec(query),
    };
    const directory = createReportScopeDirectory(createDatabase(flaky as never));

    await expect(directory.store({ id: WEST })).rejects.toThrow(/暫時性/u);
    expect(await directory.store({ id: WEST })).toMatchObject({ id: WEST });
  });
});

describe("報表統計比較期算法", () => {
  it("未完成月份只比較相同的天數序位", () => {
    const result = buildReportComparisonRanges(parseReportRange("2026-08"), "2026-08-15");

    expect(result).toMatchObject({
      granularity: "day",
      complete: false,
      asOfDate: "2026-08-15",
      current: { startDate: "2026-08-01", endDate: "2026-08-15" },
      previous: { startDate: "2026-07-01", endDate: "2026-07-15" },
      lastYear: { startDate: "2025-08-01", endDate: "2025-08-15" },
    });
  });

  it("完整月份與年份沿用完整日曆區間，且月底會夾住", () => {
    const month = buildReportComparisonRanges(parseReportRange("2026-03"), "2026-04-01");
    expect(month).toMatchObject({
      complete: true,
      previous: { startDate: "2026-02-01", endDate: "2026-02-28" },
      lastYear: { startDate: "2025-03-01", endDate: "2025-03-31" },
    });

    const leap = buildReportComparisonRanges(parseReportRange("2024-03"), "2024-03-31");
    expect(leap.previous.endDate).toBe("2024-02-29");

    const year = buildReportComparisonRanges(parseReportRange("2026"), "2027-01-01");
    expect(year).toMatchObject({
      granularity: "month",
      complete: true,
      previous: { startDate: "2025-01-01", endDate: "2025-12-31" },
      lastYear: { startDate: "2025-01-01", endDate: "2025-12-31" },
    });
  });

  it("自訂區間的上期往前推相同天數，跨年後仍保留日期範圍", () => {
    const result = buildReportComparisonRanges(
      parseReportRange(undefined, "2026-01-15", "2026-01-20"),
      "2026-02-01",
    );

    expect(result).toMatchObject({
      granularity: "day",
      previous: { startDate: "2026-01-09", endDate: "2026-01-14" },
      lastYear: { startDate: "2025-01-15", endDate: "2025-01-20" },
    });
  });

  it("分母沒有資料或為 0 時都不回傳假成長率", () => {
    const range = (total: number): ReportAnalyticsRange => ({ start: "2026-01-01", end: "2026-01-31", total, points: [] });
    expect(calculateGrowth(120, null)).toBeNull();
    expect(calculateGrowth(120, range(0))).toBeNull();
    expect(calculateGrowth(120, range(100))).toBeCloseTo(0.2);
  });
});

describe("出金統計查詢", () => {
  it("按日聚合、不補缺漏日期，並以有資料的天數計算日均", async () => {
    await upsertReportScope(db(), { id: "cyberbiz:store:停用店", scopeKind: "store", name: "停用店", active: false });
    await insertReportPayoutDaily(db(), [
      { scopeId: WEST, businessDate: "2026-08-01", payoutAmount: 2040 },
      { scopeId: EAST, businessDate: "2026-08-01", payoutAmount: 3000 },
      { scopeId: WEST, businessDate: "2026-08-03", payoutAmount: 100 },
      { scopeId: "cyberbiz:store:停用店", businessDate: "2026-08-01", payoutAmount: 9999 },
      { scopeId: WEST, businessDate: "2026-07-01", payoutAmount: 1000 },
      { scopeId: WEST, businessDate: "2025-08-01", payoutAmount: 0 },
    ]);

    const result = await queryReportPayoutSummary(db(), {
      range: parseReportRange("2026-08"),
      scopeType: "company",
      today: "2026-09-01",
    });

    expect(result).toMatchObject({
      status: "ok",
      granularity: "day",
      complete: true,
      current: {
        total: 5140,
        points: [
          { key: "2026-08-01", value: 5040 },
          { key: "2026-08-03", value: 100 },
        ],
      },
      previous: { total: 1000 },
      lastYear: { total: 0, points: [{ key: "2025-08-01", value: 0 }] },
      dailyAverage: 2570,
      dataDays: 2,
      highestDay: { date: "2026-08-01", value: 5040 },
      growth: { mom: 4.14, yoy: null },
    });
    expect(result.breakdown).toEqual([
      expect.objectContaining({ scopeId: EAST, value: 3000, channel: "cyberbiz", yoy: null }),
      expect.objectContaining({ scopeId: WEST, value: 2140, channel: "cyberbiz", yoy: null }),
    ]);
    expect(result.breakdown.some((row) => row.scopeId === "cyberbiz:store:停用店")).toBe(false);
  });

  it("單店沒有資料時回傳空狀態，不把其他店的資料算進來", async () => {
    await insertReportPayoutDaily(db(), [{ scopeId: WEST, businessDate: "2026-08-01", payoutAmount: 2040 }]);

    const result = await queryReportPayoutSummary(db(), {
      range: parseReportRange("2026-08"),
      scopeType: "store",
      scopeId: EAST,
      today: "2026-09-01",
    });

    expect(result).toMatchObject({ status: "NO_DATA_FOR_RANGE", current: { total: 0, points: [] }, breakdown: [] });
    expect(result.message).toContain("出金");
  });

  it("未完成年度查詢會依月份粒度，但比較期仍對齊已過天數", async () => {
    await insertReportPayoutDaily(db(), [
      { scopeId: WEST, businessDate: "2026-01-01", payoutAmount: 100 },
      { scopeId: WEST, businessDate: "2026-02-01", payoutAmount: 200 },
      { scopeId: WEST, businessDate: "2025-01-01", payoutAmount: 50 },
    ]);

    const result = await queryReportPayoutSummary(db(), {
      range: parseReportRange("2026"),
      scopeType: "company",
      today: "2026-02-15",
    });

    expect(result).toMatchObject({
      complete: false,
      asOfDate: "2026-02-15",
      granularity: "month",
      current: { start: "2026-01-01", end: "2026-02-15", points: [{ key: "2026-01", value: 100 }, { key: "2026-02", value: 200 }] },
      previous: { start: "2025-01-01", end: "2025-02-15" },
      lastYear: { start: "2025-01-01", end: "2025-02-15" },
    });
  });
});

describe("商品銷售統計查詢", () => {
  it("回傳分類、通路與前十名 SKU，其他 SKU 合併", async () => {
    const rows = Array.from({ length: 11 }, (_unused, index) => ({
      scopeId: WEST,
      reportMonth: "2026-07",
      sku: `SKU-${String(index).padStart(2, "0")}`,
      productName: `商品 ${index}`,
      category: index % 2 === 0 ? "沐浴" : "食品",
      grossQuantity: 10,
      returnQuantity: index,
      netQuantity: 10 - index,
      salesAmount: 1000 - index * 10,
    }));
    await insertReportSalesMonthly(db(), [
      ...rows,
      { scopeId: WEST, reportMonth: "2026-07", sku: "SKU-ZERO", productName: "零銷量商品", category: "食品", grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 },
      { scopeId: WEST, reportMonth: "2026-06", sku: "SKU-PREV", productName: "上期商品", category: "食品", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100 },
      { scopeId: WEST, reportMonth: "2025-07", sku: "SKU-LAST", productName: "去年商品", category: "食品", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 50 },
    ]);

    const { spy, reads } = countScopeReads(d1);
    const result = await queryReportSalesSummary(createDatabase(spy as never), {
      range: parseReportRange("2026-07"),
      scopeType: "company",
      today: "2026-08-01",
    });

    // 名冊在整份統計裡共用一份，不是每個子查詢各讀一次。
    expect(reads()).toBe(1);

    // 指定店別也是同一份名冊推導出來的，不必再查一次 scopes。
    const store = countScopeReads(d1);
    await queryReportSalesSummary(createDatabase(store.spy as never), {
      range: parseReportRange("2026-07"),
      scopeType: "store",
      scopeId: WEST,
      today: "2026-08-01",
    });
    expect(store.reads()).toBe(1);

    expect(result).toMatchObject({
      status: "ok",
      granularity: "month",
      salesAmount: 10450,
      grossQuantity: 110,
      returnQuantity: 55,
      netQuantity: 55,
      returnRate: 0.5,
      skuCount: 11,
      current: { total: 10450, points: [{ key: "2026-07", value: 10450 }] },
      currentQuantity: { total: 55, points: [{ key: "2026-07", value: 55 }] },
      trend: {
        start: "2025-07-01",
        end: "2026-07-31",
        points: expect.arrayContaining([
          { key: "2025-07", value: 50 },
          { key: "2026-06", value: 100 },
          { key: "2026-07", value: 10450 },
        ]),
      },
      previous: { total: 100 },
      lastYear: { total: 50 },
      growth: { mom: 103.5, yoy: 208 },
      quantityGrowth: { mom: 54, yoy: 54 },
    });
    expect(result.byCategory).toHaveLength(2);
    expect(result.breakdown).toEqual([expect.objectContaining({ scopeId: WEST, channel: "cyberbiz", value: 10450, yoy: 208 })]);
    expect(result.byTopSku).toHaveLength(11);
    expect(result.byTopSku[0]).toMatchObject({ sku: "SKU-00", productName: "商品 0" });
    expect(result.byTopSku.at(-1)).toMatchObject({ productName: "其他", isOther: true });
    expect(result.bySku).toHaveLength(result.skuCount);
    expect(result.bySku.every((row) => !row.isOther)).toBe(true);
    expect(result.bySku.some((row) => row.sku === "SKU-ZERO")).toBe(false);

    const fullMonthByDate = await queryReportSalesSummary(db(), {
      range: parseReportRange(undefined, "2026-07-01", "2026-07-31"),
      scopeType: "company",
      today: "2026-08-01",
    });
    expect(fullMonthByDate).toMatchObject({
      status: "ok",
      previous: { total: 100 },
      lastYear: { total: 50 },
      growth: { mom: 103.5, yoy: 208 },
    });

    const byQuantity = await queryReportSalesSummary(db(), {
      range: parseReportRange("2026-07"),
      scopeType: "company",
      topSkuBy: "netQuantity",
      today: "2026-08-01",
    });
    expect(byQuantity.topSkuBy).toBe("netQuantity");
    expect(byQuantity.byTopSku[0]).toMatchObject({ sku: "SKU-00", value: 10 });

    const byProduct = await queryReportSalesSummary(db(), {
      range: parseReportRange("2026-07"),
      scopeType: "company",
      productQuery: "商品 0",
      today: "2026-08-01",
    });
    expect(byProduct).toMatchObject({ skuCount: 1, netQuantity: 10, salesAmount: 1000 });
    expect(byProduct.byTopSku).toEqual([expect.objectContaining({ sku: "SKU-00", productName: "商品 0" })]);

    const missingProduct = await queryReportSalesSummary(db(), {
      range: parseReportRange("2026-07"),
      scopeType: "company",
      productQuery: "不存在的商品",
      today: "2026-08-01",
    });
    expect(missingProduct.status).toBe("NO_DATA_FOR_RANGE");

    await insertReportSalesMonthly(db(), [{
      scopeId: WEST,
      reportMonth: "2026-06",
      sku: "SKU-HISTORY",
      productName: "只有歷史資料的商品",
      category: "沐浴",
      grossQuantity: 4,
      returnQuantity: 0,
      netQuantity: 4,
      salesAmount: 400,
    }]);
    const noCurrentProduct = await queryReportSalesSummary(db(), {
      range: parseReportRange("2026-07"),
      scopeType: "company",
      productQuery: "只有歷史資料的商品",
      today: "2026-08-01",
    });
    expect(noCurrentProduct).toMatchObject({
      status: "NO_DATA_FOR_RANGE",
      growth: { mom: null, yoy: null },
      quantityGrowth: { mom: null, yoy: null },
    });
  });

  it("非完整月份區間回傳明確的不支援狀態", async () => {
    const result = await queryReportSalesSummary(db(), {
      range: parseReportRange(undefined, "2026-07-02", "2026-07-31"),
      scopeType: "company",
      today: "2026-08-01",
    });

    expect(result).toMatchObject({ status: "UNSUPPORTED_GRANULARITY", message: "商品銷售統計目前只支援完整月份查詢。" });
  });
});
