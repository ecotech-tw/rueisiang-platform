import { createDatabase, upsertReportScope } from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rueisiang/db";
import app from "./index.js";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const TOKEN = "report-ingest-secret";
let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

function request(body: unknown, token = TOKEN) {
  return app.fetch(new Request("https://platform.example.test/api/internal/cyberbiz-reports/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cyberbiz-report-token": token },
    body: JSON.stringify(body),
  }), { DB: d1, CYBERBIZ_REPORT_INGEST_TOKEN: TOKEN } as never);
}

function salesBody(rows: unknown[], reportMonth = "2026-07") {
  return {
    kind: "sales",
    scopeType: "store",
    scopeId: "cyberbiz:store:a",
    scopeName: "測試店",
    reportMonth,
    rows,
  };
}

function salesRow(sku: string, salesAmount: number, extra: Record<string, unknown> = {}) {
  return {
    sku,
    productName: "商品",
    category: "沐浴",
    grossQuantity: 1,
    returnQuantity: 0,
    netQuantity: 1,
    salesAmount,
    ...extra,
  };
}

function shopeeBundle(salesRows: unknown[], payoutRows: unknown[] = [], reportMonth = "2026-07") {
  return {
    kind: "sales_and_payout",
    scopeType: "store",
    scopeId: "shopee:store:default",
    scopeName: "蝦皮",
    reportMonth,
    salesRows,
    payoutRows,
  };
}

beforeEach(async () => {
  d1 = createLocalD1();
  const database = db();
  await database.insert(schema.productCategories).values({ id: "category-bath", name: "沐浴", color: "rose" });
  for (const sku of ["SKU-1", "SKU-OLD", "SKU-KEEP", "SKU-2", "WMS-001"]) {
    await database.insert(schema.inventoryItems).values({
      id: `item-${sku.toLowerCase()}`,
      sku,
      name: `WMS ${sku}`,
      category: "沐浴",
    });
  }
  await database.insert(schema.productSkuMappings).values({
    id: "mapping-shopee-p-001",
    inventoryItemId: "item-wms-001",
    externalSku: "P-001",
  });
});

describe("報表月資料匯入", () => {
  it("只需要 ingest token，寫入 scope 與商品銷售月資料", async () => {
    const unauthorized = await request(salesBody([]), "wrong");
    expect(unauthorized.status).toBe(401);

    const response = await request(salesBody([
      salesRow("SKU-1", 180, { grossQuantity: 3, returnQuantity: 1, netQuantity: 2 }),
      salesRow("SKU-1", 90, { productName: "", category: "", grossQuantity: 2, netQuantity: 2 }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "sales", rowCount: 1 } });

    const result = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "store", scopeName: "測試店" });
    expect(result).toMatchObject({ status: "ok", totals: { netQuantity: 4, salesAmount: 270 } });
  });

  it("同一月重匯會清掉已移除的 SKU", async () => {
    expect((await request(salesBody([salesRow("SKU-OLD", 300), salesRow("SKU-KEEP", 200)]))).status).toBe(200);
    expect((await request(salesBody([salesRow("SKU-KEEP", 90)]))).status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "store", scopeName: "測試店", groupBy: ["sku"],
    });
    expect(result.rows).toEqual([expect.objectContaining({ sku: "SKU-KEEP", netQuantity: 1, salesAmount: 90 })]);
    expect(result.totals).toEqual({ grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 90 });
  });

  it("整月零筆也會清掉該月份的舊資料", async () => {
    expect((await request(salesBody([salesRow("SKU-1", 100)]))).status).toBe(200);
    expect((await request(salesBody([]))).status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "store", scopeName: "測試店" });
    expect(result.status).toBe("NO_DATA_FOR_RANGE");
  });

  it("移除 businessDate 與 coveredDates，改要求 sales 的 reportMonth", async () => {
    expect((await request({ ...salesBody([]), reportMonth: undefined })).status).toBe(422);
    expect((await request({ ...salesBody([salesRow("SKU-1", 100)]), coveredDates: ["2026-07-01"] })).status).toBe(422);
    expect((await request({ ...salesBody([{ ...salesRow("SKU-1", 100), businessDate: "2026-07-01" }]), reportMonth: "2026-07" })).status).toBe(422);
    expect((await request({ ...salesBody([{ ...salesRow("SKU-1", 100), reportMonth: "2026-07" }]), reportMonth: undefined })).status).toBe(200);
    expect((await request({ ...salesBody([{ ...salesRow("SKU-1", 100), reportMonth: "2026-08" }]), reportMonth: "2026-07" })).status).toBe(422);
  });

  it("同一天的 payout rows 在匯入時加總，重跑時以新日資料取代", async () => {
    const first = await request({
      kind: "payout", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: [{ businessDate: "2026-07-01", payoutAmount: 100 }, { businessDate: "2026-07-01", payoutAmount: 25 }],
    });
    expect(first.status).toBe(200);
    await request({
      kind: "payout", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: [{ businessDate: "2026-07-01", payoutAmount: 80 }],
    });
    const result = await createCyberbizReportService(db()).queryPayout({ period: "2026-07", scopeType: "store", scopeName: "測試店" });
    expect(result).toMatchObject({ status: "ok", totals: { payoutAmount: 80 } });
  });

  it("同一份蝦皮報表可以一次寫入月 sales 與日 payout，並以 shopee scope ID 隔離", async () => {
    await upsertReportScope(db(), { id: "cyberbiz:store:legacy", scopeKind: "store", name: "舊有 CYBERBIZ 同名" });
    const response = await request(shopeeBundle([
      salesRow("P-001", 0, { reportMonth: "2026-07", grossQuantity: 3, returnQuantity: 1, netQuantity: 2 }),
    ], [{ businessDate: "2026-07-01", payoutAmount: 250 }]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: {
      kind: "sales_and_payout",
      scopeId: "shopee:store:default",
      salesRowCount: 1,
      payoutRowCount: 1,
    } });

    const sales = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "store", scopeName: "蝦皮" });
    const payout = await createCyberbizReportService(db()).queryPayout({ period: "2026-07", scopeType: "store", scopeName: "蝦皮" });
    expect(sales).toMatchObject({ status: "ok", scopeId: "shopee:store:default", totals: { grossQuantity: 3, netQuantity: 2 } });
    expect(payout).toMatchObject({ status: "ok", scopeId: "shopee:store:default", totals: { payoutAmount: 250 } });
  });

  it("同一外部 SKU 有 legacy 與通路 mapping 時優先使用指定通路", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "mapping-shopee-specific",
      inventoryItemId: "item-sku-1",
      channel: "shopee",
      externalSku: "P-001",
    });

    const response = await request(shopeeBundle([salesRow("P-001", 100)]));
    expect(response.status).toBe(200);
    expect(await db().select({ sku: schema.reportSalesMonthly.sku }).from(schema.reportSalesMonthly))
      .toEqual([{ sku: "SKU-1" }]);
  });

  it("蝦皮組合商品會依用料數量展開到各 WMS SKU", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "mapping-shopee-bundle",
      inventoryItemId: "item-sku-1",
      channel: "shopee",
      externalSku: "P-001_M-001",
    });
    await db().insert(schema.productBundleComponents).values([
      { mappingId: "mapping-shopee-bundle", inventoryItemId: "item-sku-1", quantity: 2 },
      { mappingId: "mapping-shopee-bundle", inventoryItemId: "item-sku-2", quantity: 1 },
    ]);

    const response = await request(shopeeBundle([
      salesRow("P-001_M-001", 0, { grossQuantity: 3, returnQuantity: 1, netQuantity: 2 }),
    ]));
    expect(response.status).toBe(200);
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      returnQuantity: schema.reportSalesMonthly.returnQuantity,
      netQuantity: schema.reportSalesMonthly.netQuantity,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly).orderBy(schema.reportSalesMonthly.sku)).toEqual([
      { sku: "SKU-1", grossQuantity: 6, returnQuantity: 2, netQuantity: 4, salesAmount: 0 },
      { sku: "SKU-2", grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 0 },
    ]);
  });

  it("蝦皮新規格 SKU 會沿用舊商品 ID mapping", async () => {
    const response = await request(shopeeBundle([
      salesRow("P-001_M-001", 0, { grossQuantity: 3, returnQuantity: 1, netQuantity: 2 }),
    ]));
    expect(response.status).toBe(200);
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      netQuantity: schema.reportSalesMonthly.netQuantity,
    }).from(schema.reportSalesMonthly)).toEqual([{
      sku: "WMS-001",
      grossQuantity: 3,
      netQuantity: 2,
    }]);
  });

  it("任一通路的組合商品都會展開，且銷售額不會重複計算", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "mapping-cyberbiz-bundle",
      inventoryItemId: "item-sku-1",
      channel: "cyberbiz",
      externalSku: "BUNDLE-001",
    });
    await db().insert(schema.productBundleComponents).values([
      { mappingId: "mapping-cyberbiz-bundle", inventoryItemId: "item-sku-2", quantity: 1 },
      { mappingId: "mapping-cyberbiz-bundle", inventoryItemId: "item-sku-1", quantity: 2 },
    ]);

    const response = await request(salesBody([
      salesRow("BUNDLE-001", 100, { grossQuantity: 3, returnQuantity: 1, netQuantity: 2 }),
    ]));
    expect(response.status).toBe(200);
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      netQuantity: schema.reportSalesMonthly.netQuantity,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly).orderBy(schema.reportSalesMonthly.sku)).toEqual([
      { sku: "SKU-1", grossQuantity: 6, netQuantity: 4, salesAmount: 100 },
      { sku: "SKU-2", grossQuantity: 3, netQuantity: 2, salesAmount: 0 },
    ]);
  });

  it("自訂 SKU mapping 可讓 CYBERBIZ 與蝦皮共用同一組 WMS 用料", async () => {
    await db().insert(schema.productSkuMappings).values([
      {
        id: "mapping-custom-cyberbiz",
        inventoryItemId: null,
        channel: "cyberbiz",
        systemSku: "ABX30001",
        externalName: "日光花園三入自選禮盒",
        externalSku: "ABX30001",
      },
      {
        id: "mapping-custom-shopee",
        inventoryItemId: null,
        channel: "shopee",
        systemSku: "ABX30001",
        externalName: "日光花園三入自選禮盒",
        externalSku: "26491332332_216256146329",
      },
    ]);
    await db().insert(schema.productBundleComponents).values([
      { mappingId: "mapping-custom-cyberbiz", inventoryItemId: "item-sku-1", quantity: 2 },
      { mappingId: "mapping-custom-cyberbiz", inventoryItemId: "item-sku-2", quantity: 1 },
      { mappingId: "mapping-custom-shopee", inventoryItemId: "item-sku-1", quantity: 2 },
      { mappingId: "mapping-custom-shopee", inventoryItemId: "item-sku-2", quantity: 1 },
    ]);

    expect((await request(salesBody([
      salesRow("ABX30001", 100, { grossQuantity: 2, netQuantity: 2 }),
    ]))).status).toBe(200);
    expect((await request(shopeeBundle([
      salesRow("26491332332_216256146329", 0, { grossQuantity: 3, netQuantity: 3 }),
    ]))).status).toBe(200);

    const rows = await db().select({
      scopeId: schema.reportSalesMonthly.scopeId,
      sku: schema.reportSalesMonthly.sku,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly);
    expect(rows).toEqual(expect.arrayContaining([
      { scopeId: "cyberbiz:store:a", sku: "ABX30001", grossQuantity: 2, salesAmount: 100 },
      { scopeId: "shopee:store:default", sku: "ABX30001", grossQuantity: 3, salesAmount: 0 },
    ]));

    const byShopeeProductId = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeName: "蝦皮",
      sku: "26491332332_216256146329",
    });
    expect(byShopeeProductId).toMatchObject({ status: "ok", totals: { grossQuantity: 3 } });
  });

  it("同一 system SKU 的商品 metadata 優先使用 WMS 商品資料", async () => {
    await db().insert(schema.productSkuMappings).values([
      {
        id: "mapping-wms-alias",
        inventoryItemId: "item-sku-1",
        channel: "cyberbiz",
        externalName: "WMS 商品別名",
        externalSku: "WMS-ALIAS",
      },
      {
        id: "mapping-custom-alias",
        inventoryItemId: null,
        channel: "cyberbiz",
        systemSku: "SKU-1",
        externalName: "通路自訂名稱",
        externalSku: "CUSTOM-ALIAS",
      },
    ]);
    await db().insert(schema.productBundleComponents).values({
      mappingId: "mapping-custom-alias", inventoryItemId: "item-sku-1", quantity: 1,
    });

    const response = await request(salesBody([
      salesRow("CUSTOM-ALIAS", 20),
      salesRow("WMS-ALIAS", 100),
    ]));
    expect(response.status).toBe(200);
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly)).toEqual([{
      sku: "SKU-1",
      productName: "WMS SKU-1",
      grossQuantity: 2,
      salesAmount: 120,
    }]);
  });

  it("CYBERBIZ 同名 scope 不會重用其他通路的 scope", async () => {
    await upsertReportScope(db(), { id: "momo:store:default", scopeKind: "store", name: "測試店" });

    const response = await request(salesBody([salesRow("SKU-1", 100)]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { scopeId: "cyberbiz:store:a" } });
    expect(await db().select({ id: schema.reportScopes.id }).from(schema.reportScopes))
      .toEqual(expect.arrayContaining([{ id: "momo:store:default" }, { id: "cyberbiz:store:a" }]));
  });

  it("sales 格式錯誤時不會先留下 payout", async () => {
    const response = await request(shopeeBundle([
      { ...salesRow("P-001", 0), businessDate: "2026-07-01" },
    ], [{ businessDate: "2026-07-01", payoutAmount: 250 }]));
    expect(response.status).toBe(422);
    expect(await db().select().from(schema.reportPayoutDaily)).toEqual([]);
  });

  it("蝦皮 bundle 重新匯入零筆月份會清掉既有商品資料", async () => {
    expect((await request(shopeeBundle([salesRow("P-001", 0)]))).status).toBe(200);
    expect((await request(shopeeBundle([]))).status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "store", scopeName: "蝦皮" });
    expect(result?.status).toBe("NO_DATA_FOR_RANGE");
  });

  it("沿用既有同名 scope 的 ID，避免設定路徑改名後產生重複據點", async () => {
    await upsertReportScope(db(), { id: "legacy-store-id", scopeKind: "store", name: "測試店" });
    await db().insert(schema.productSkuMappings).values({
      id: "mapping-cyberbiz-p-001",
      inventoryItemId: "item-sku-1",
      channel: "cyberbiz",
      externalSku: "P-001",
    });
    const response = await request({
      ...salesBody([salesRow("P-001", 100)]), scopeId: "cyberbiz:store:new-id",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { scopeId: "legacy-store-id" } });
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "store", scopeId: "legacy-store-id", groupBy: ["sku"],
    });
    expect(result).toMatchObject({ status: "ok", scopeId: "legacy-store-id", totals: { netQuantity: 1, salesAmount: 100 } });
    expect(result.rows).toEqual([expect.objectContaining({ sku: "SKU-1", salesAmount: 100 })]);
  });

  it("以 scope ID 前綴解析自由輸入的通路 mapping", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "mapping-etsy-e-001",
      inventoryItemId: "item-sku-1",
      channel: "etsy",
      externalSku: "E-001",
    });
    const response = await request({
      ...salesBody([salesRow("E-001", 100)]),
      scopeId: "etsy:store:default",
      scopeName: "Etsy",
    });
    expect(response.status).toBe(200);
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "store", scopeId: "etsy:store:default", groupBy: ["sku"],
    });
    expect(result.rows).toEqual([expect.objectContaining({ sku: "SKU-1", salesAmount: 100 })]);
  });

  it("商品名稱與分類以 WMS 商品主檔為準", async () => {
    const response = await request(salesBody([
      salesRow("SKU-1", 100),
      salesRow("SKU-1", 80, { productName: "", category: "" }),
      salesRow("SKU-2", 50, { productName: "", category: "" }),
    ]));
    expect(response.status).toBe(200);
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "store", scopeName: "測試店", groupBy: ["sku", "category"],
    });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: "SKU-1", category: "沐浴", netQuantity: 2, salesAmount: 180 }),
      expect.objectContaining({ sku: "SKU-2", category: "沐浴", netQuantity: 1, salesAmount: 50 }),
    ]));
    expect(await db().select({ sku: schema.reportSalesMonthly.sku, productName: schema.reportSalesMonthly.productName })
      .from(schema.reportSalesMonthly)
      .orderBy(schema.reportSalesMonthly.sku)).toEqual([
      { sku: "SKU-1", productName: "WMS SKU-1" },
      { sku: "SKU-2", productName: "WMS SKU-2" },
    ]);
  });

  it("大量 SKU 會分批查詢 mapping，不受單支 SQL 參數上限影響", async () => {
    const items = Array.from({ length: 120 }, (_unused, index) => {
      const sku = `BULK-${String(index).padStart(3, "0")}`;
      return { id: `item-${sku.toLowerCase()}`, sku, name: `WMS ${sku}`, category: "沐浴" };
    });
    await db().insert(schema.inventoryItems).values(items);

    const response = await request(salesBody(items.map((item) => salesRow(item.sku, 10))));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { rowCount: 120 } });
    expect(await db().select().from(schema.reportSalesMonthly)).toHaveLength(120);
  });

  it("不同外部 SKU 對應同一 WMS 商品時會先 mapping 再加總", async () => {
    await db().insert(schema.productSkuMappings).values([
      { id: "mapping-cyberbiz-001", inventoryItemId: "item-wms-001", externalSku: "CB-001" },
      { id: "mapping-shopee-001", inventoryItemId: "item-wms-001", externalSku: "SHOPEE-001" },
    ]);
    const response = await request(salesBody([
      salesRow("CB-001", 120, { grossQuantity: 2, netQuantity: 2, productName: "CYBERBIZ 名稱", category: "錯誤分類" }),
      salesRow("shopee-001", 80, { grossQuantity: 3, netQuantity: 3, productName: "蝦皮名稱", category: "其他分類" }),
    ]));
    expect(response.status).toBe(200);

    const rows = await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
      category: schema.reportSalesMonthly.category,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly);
    expect(rows).toEqual([{
      sku: "WMS-001",
      productName: "WMS WMS-001",
      category: "沐浴",
      grossQuantity: 5,
      salesAmount: 200,
    }]);
  });

  it("組合用料缺 WMS SKU 時整筆視為未對應，不會靜默少算", async () => {
    // 0057 的回填會替每一筆舊 mapping 補一列用料，不管該商品有沒有 SKU。
    await db().insert(schema.inventoryItems).values({
      id: "item-no-sku", sku: null, name: "沒有 SKU 的商品", category: "沐浴",
    });
    await db().insert(schema.productSkuMappings).values({
      id: "mapping-shopee-broken",
      inventoryItemId: "item-sku-1",
      channel: "shopee",
      externalSku: "P-002_M-001",
    });
    await db().insert(schema.productBundleComponents).values([
      { mappingId: "mapping-shopee-broken", inventoryItemId: "item-sku-1", quantity: 2 },
      { mappingId: "mapping-shopee-broken", inventoryItemId: "item-no-sku", quantity: 1 },
    ]);

    const response = await request(shopeeBundle([
      salesRow("P-002_M-001", 0, { grossQuantity: 3, returnQuantity: 0, netQuantity: 3 }),
    ]));
    expect(response.status).toBe(422);
    expect(await db().select().from(schema.reportSalesMonthly)).toEqual([]);
  });

  it("未對應外部 SKU 不會把原始值寫進報表", async () => {
    const response = await request(salesBody([salesRow("NOT-MAPPED", 100)]));
    expect(response.status).toBe(422);
    expect(await db().select().from(schema.reportSalesMonthly)).toEqual([]);
  });

  it("bundle 的 sales mapping 失敗時仍會先保存 payout", async () => {
    const response = await request(shopeeBundle(
      [salesRow("NOT-MAPPED", 100)],
      [{ businessDate: "2026-07-01", payoutAmount: 250 }],
    ));
    expect(response.status).toBe(422);
    expect(await db().select().from(schema.reportSalesMonthly)).toEqual([]);
    expect(await db().select().from(schema.reportPayoutDaily)).toMatchObject([
      { scopeId: "shopee:store:default", businessDate: "2026-07-01", payoutAmount: 250 },
    ]);
  });

  it("公司查詢會把 CYBERBIZ 與蝦皮的相同 WMS SKU 一起加總", async () => {
    expect((await request(salesBody([salesRow("WMS-001", 100), salesRow("WMS-001", 50)]))).status).toBe(200);
    expect((await request(shopeeBundle([salesRow("P-001", 0, { grossQuantity: 3, netQuantity: 3 })]))).status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "company", groupBy: ["sku"],
    });
    expect(result).toMatchObject({ status: "ok", totals: { grossQuantity: 5, netQuantity: 5, salesAmount: 150 } });
    expect(result.rows).toEqual([expect.objectContaining({ sku: "WMS-001", grossQuantity: 5, salesAmount: 150 })]);
  });
});
