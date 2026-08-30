import { createDatabase, upsertReportScope } from "@rueisiang/db";
import { eq } from "drizzle-orm";
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

/**
 * 種一筆對應與它的用料。
 *
 * 用料寫成 { item } 或 { custom }，對應到新的兩種來源；custom 會順手建立報表自訂商品，
 * 讓測試不必自己管 custom_report_products 的 id。
 */
type SeedComponent =
  | { item: string; quantity?: number }
  | { custom: string; name?: string; category?: string; quantity?: number };

async function seedMapping(input: {
  id: string;
  channel?: string;
  externalSku: string;
  externalName?: string;
  components: SeedComponent[];
}) {
  const database = db();
  await database.insert(schema.productSkuMappings).values({
    id: input.id,
    channel: input.channel ?? "legacy",
    externalName: input.externalName ?? input.externalSku,
    externalSku: input.externalSku,
  });
  const rows = [];
  for (const [index, component] of input.components.entries()) {
    if ("item" in component) {
      rows.push({
        id: `${input.id}:${index}`,
        mappingId: input.id,
        inventoryItemId: component.item,
        customProductId: null,
        quantity: component.quantity ?? 1,
      });
      continue;
    }
    const customId = `custom-${component.custom}`;
    const [existing] = await database
      .select({ id: schema.customReportProducts.id })
      .from(schema.customReportProducts)
      .where(eq(schema.customReportProducts.id, customId));
    if (!existing) {
      await database.insert(schema.customReportProducts).values({
        id: customId,
        sku: component.custom,
        name: component.name ?? component.custom,
        category: component.category ?? "未分類",
      });
    }
    rows.push({
      id: `${input.id}:${index}`,
      mappingId: input.id,
      inventoryItemId: null,
      customProductId: customId,
      quantity: component.quantity ?? 1,
    });
  }
  await database.insert(schema.productBundleComponents).values(rows);
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
  await seedMapping({ id: "mapping-shopee-p-001", externalSku: "P-001", components: [{ item: "item-wms-001" }] });
});

/*
 * 端到端：兩個通路的同一個商品要在報表裡合成一筆。
 *
 * CYBERBIZ 的商品銷售報表用官網 SKU，不必建對應；蝦皮的訂單詳細列表用
 * 「商品ID_規格ID」，靠 SKU 對應換算成官網 SKU 與官網名稱——蝦皮上叫什麼都不影響報表。
 */
describe("跨通路商品身分", () => {
  beforeEach(async () => {
    await db().insert(schema.cyberbizProducts).values([
      { sku: "SOAP-001", productId: "p-1", variantId: "v-1", productName: "香皂", variantName: "" },
      { sku: "NET-001", productId: "p-2", variantId: "v-2", productName: "起泡網", variantName: "" },
    ]);
  });

  it("CYBERBIZ 報表直接匯入，不需要任何對應", async () => {
    const response = await request(salesBody([
      salesRow("SOAP-001", 300, { grossQuantity: 3, netQuantity: 3, productName: "報表上的名稱" }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: [] } });
    // 名稱以官網目錄為準，不採信報表列上的字。
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
      netQuantity: schema.reportSalesMonthly.netQuantity,
    }).from(schema.reportSalesMonthly)).toEqual([
      { sku: "SOAP-001", productName: "香皂", netQuantity: 3 },
    ]);
  });

  it("蝦皮商品經由對應換成官網 SKU 與官網名稱，蝦皮自己的名稱不進報表", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "m-shopee-soap", channel: "shopee", externalName: "皂", externalSku: "12345_67890",
    });
    await db().insert(schema.productBundleComponents).values({
      id: "m-shopee-soap:000", mappingId: "m-shopee-soap",
      inventoryItemId: null, customProductId: null, cyberbizSku: "SOAP-001", quantity: 1,
    });

    expect((await request(shopeeBundle([
      salesRow("12345_67890", 0, { grossQuantity: 4, netQuantity: 4, productName: "皂" }),
    ]))).status).toBe(200);

    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
      netQuantity: schema.reportSalesMonthly.netQuantity,
    }).from(schema.reportSalesMonthly)).toEqual([
      { sku: "SOAP-001", productName: "香皂", netQuantity: 4 },
    ]);
  });

  it("一個蝦皮商品可以對應到多個 CYBERBIZ SKU，依數量展開", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "m-shopee-set", channel: "shopee", externalName: "洗沐組", externalSku: "999_888",
    });
    await db().insert(schema.productBundleComponents).values([
      { id: "m-shopee-set:000", mappingId: "m-shopee-set", inventoryItemId: null, customProductId: null, cyberbizSku: "SOAP-001", quantity: 2 },
      { id: "m-shopee-set:001", mappingId: "m-shopee-set", inventoryItemId: null, customProductId: null, cyberbizSku: "NET-001", quantity: 1 },
    ]);

    expect((await request(shopeeBundle([
      salesRow("999_888", 500, { grossQuantity: 3, returnQuantity: 1, netQuantity: 2 }),
    ]))).status).toBe(200);

    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
      grossQuantity: schema.reportSalesMonthly.grossQuantity,
      netQuantity: schema.reportSalesMonthly.netQuantity,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly).orderBy(schema.reportSalesMonthly.sku)).toEqual([
      // 數量依用料倍數展開；銷售額整筆放第一列用料，不重複計算。
      { sku: "NET-001", productName: "起泡網", grossQuantity: 3, netQuantity: 2, salesAmount: 0 },
      { sku: "SOAP-001", productName: "香皂", grossQuantity: 6, netQuantity: 4, salesAmount: 500 },
    ]);
  });

  it("公司層級查詢會把 CYBERBIZ 與蝦皮的同一個商品加總", async () => {
    await db().insert(schema.productSkuMappings).values({
      id: "m-shopee-soap", channel: "shopee", externalName: "皂", externalSku: "12345_67890",
    });
    await db().insert(schema.productBundleComponents).values({
      id: "m-shopee-soap:000", mappingId: "m-shopee-soap",
      inventoryItemId: null, customProductId: null, cyberbizSku: "SOAP-001", quantity: 1,
    });

    expect((await request(salesBody([salesRow("SOAP-001", 300, { grossQuantity: 3, netQuantity: 3 })]))).status).toBe(200);
    expect((await request(shopeeBundle([salesRow("12345_67890", 0, { grossQuantity: 4, netQuantity: 4 })]))).status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "company", sku: "SOAP-001",
    });
    expect(result.rows).toMatchObject([{ sku: "SOAP-001", netQuantity: 7 }]);
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
    await seedMapping({ id: "mapping-shopee-specific", channel: "shopee", externalSku: "P-001", components: [{ item: "item-sku-1" }] });

    const response = await request(shopeeBundle([salesRow("P-001", 100)]));
    expect(response.status).toBe(200);
    expect(await db().select({ sku: schema.reportSalesMonthly.sku }).from(schema.reportSalesMonthly))
      .toEqual([{ sku: "SKU-1" }]);
  });

  it("蝦皮組合商品會依用料數量展開到各 WMS SKU", async () => {
    await seedMapping({ id: "mapping-shopee-bundle", channel: "shopee", externalSku: "P-001_M-001", components: [{ item: "item-sku-1", quantity: 2 }, { item: "item-sku-2", quantity: 1 }] });

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
    await seedMapping({ id: "mapping-cyberbiz-bundle", channel: "cyberbiz", externalSku: "BUNDLE-001", components: [{ item: "item-sku-2", quantity: 1 }, { item: "item-sku-1", quantity: 2 }] });

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
      // 銷售額整筆放在「第一列用料」上——這裡是 item-sku-2，因為它排在用料清單第一個。
      { sku: "SKU-1", grossQuantity: 6, netQuantity: 4, salesAmount: 0 },
      { sku: "SKU-2", grossQuantity: 3, netQuantity: 2, salesAmount: 100 },
    ]);
  });

  it("自訂用料可讓 CYBERBIZ 與蝦皮統計成同一個商品", async () => {
    // 兩個通路各自的外部 SKU，指到同一個自訂用料——報表就會統計成同一個商品。
    await seedMapping({
      id: "mapping-custom-cyberbiz", channel: "cyberbiz", externalSku: "ABX30001",
      externalName: "日光花園三入自選禮盒",
      components: [{ custom: "ABX30001", name: "日光花園三入自選禮盒" }],
    });
    await seedMapping({
      id: "mapping-custom-shopee", channel: "shopee", externalSku: "26491332332_216256146329",
      externalName: "日光花園三入自選禮盒",
      components: [{ custom: "ABX30001", name: "日光花園三入自選禮盒" }],
    });

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

  it("兩個外部 SKU 指到同一個 WMS 用料時合併，名稱取自商品主檔", async () => {
    // 通路商品名稱各自不同，但報表那一行的名稱來自用料本身，不會被通路名稱蓋掉。
    await seedMapping({
      id: "mapping-wms-alias", channel: "cyberbiz", externalSku: "WMS-ALIAS",
      externalName: "WMS 商品別名", components: [{ item: "item-sku-1" }],
    });
    await seedMapping({
      id: "mapping-custom-alias", channel: "cyberbiz", externalSku: "CUSTOM-ALIAS",
      externalName: "通路自訂名稱", components: [{ item: "item-sku-1" }],
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
    await seedMapping({ id: "mapping-cyberbiz-p-001", channel: "cyberbiz", externalSku: "P-001", components: [{ item: "item-sku-1" }] });
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
    await seedMapping({ id: "mapping-etsy-e-001", channel: "etsy", externalSku: "E-001", components: [{ item: "item-sku-1" }] });
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
    await seedMapping({ id: "mapping-cyberbiz-001", externalSku: "CB-001", components: [{ item: "item-wms-001" }] });
    await seedMapping({ id: "mapping-shopee-001", externalSku: "SHOPEE-001", components: [{ item: "item-wms-001" }] });
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
    await seedMapping({ id: "mapping-shopee-broken", channel: "shopee", externalSku: "P-002_M-001", components: [{ item: "item-sku-1", quantity: 2 }, { item: "item-no-sku", quantity: 1 }] });

    const response = await request(shopeeBundle([
      salesRow("P-002_M-001", 0, { grossQuantity: 3, returnQuantity: 0, netQuantity: 3 }),
    ]));
    // 略過而不是靜默少算：那筆完全不寫，而且會出現在提醒清單裡。
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: ["P-002_M-001"] } });
    expect(await db().select().from(schema.reportSalesMonthly)).toEqual([]);
  });

  it("CYBERBIZ 目錄有的商品不必建對應也進得了報表", async () => {
    /*
     * 官網有、WMS 沒有的商品（禮盒、贈品、加購）以前得手動 key 一個自訂 SKU 與名稱，
     * 十幾個這種 SKU 就擋掉九家店的整個月。
     */
    await db().insert(schema.cyberbizProducts).values({
      sku: "AGT0001", productId: "p-1", variantId: "v-1", productName: "提袋", variantName: "大",
    });

    const response = await request(salesBody([
      salesRow("AGT0001", 150, { grossQuantity: 4, netQuantity: 4 }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: [] } });
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
      salesAmount: schema.reportSalesMonthly.salesAmount,
    }).from(schema.reportSalesMonthly)).toEqual([
      { sku: "AGT0001", productName: "提袋（大）", salesAmount: 150 },
    ]);
  });

  it("WMS 商品與明確 mapping 都贏過 CYBERBIZ 目錄", async () => {
    // 目錄只是「都對不到」時的退路，不該蓋掉既有的對應關係。
    await db().insert(schema.cyberbizProducts).values({
      sku: "SKU-1", productId: "p-9", variantId: "v-9", productName: "官網名稱", variantName: "",
    });

    expect((await request(salesBody([salesRow("SKU-1", 100, { grossQuantity: 2, netQuantity: 2 })]))).status).toBe(200);
    expect(await db().select({
      sku: schema.reportSalesMonthly.sku,
      productName: schema.reportSalesMonthly.productName,
    }).from(schema.reportSalesMonthly)).toEqual([{ sku: "SKU-1", productName: "WMS SKU-1" }]);
  });

  it("未對應外部 SKU 會被略過，其餘照常寫入並回報", async () => {
    /*
     * 以前是整份 422。實際上十幾個沒對應的 SKU 讓九家店的整個月一筆都進不去，
     * 一個沒對應的贈品擋掉全部營收，代價完全不成比例。
     */
    const response = await request(salesBody([
      salesRow("NOT-MAPPED", 100),
      salesRow("SKU-1", 200, { grossQuantity: 5, netQuantity: 5 }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: ["NOT-MAPPED"] } });
    expect(await db().select({ sku: schema.reportSalesMonthly.sku }).from(schema.reportSalesMonthly))
      .toEqual([{ sku: "SKU-1" }]);
  });

  it("標記為不納入報表的 SKU 略過但不列進提醒", async () => {
    await db().insert(schema.reportSkuIgnores).values({
      id: "ignore-1", channel: "cyberbiz", externalSku: "RESEND-001", reason: "補寄用",
    });

    const response = await request(salesBody([
      salesRow("RESEND-001", 100),
      salesRow("SKU-1", 200, { grossQuantity: 5, netQuantity: 5 }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: [] } });
    expect(await db().select({ sku: schema.reportSalesMonthly.sku }).from(schema.reportSalesMonthly))
      .toEqual([{ sku: "SKU-1" }]);
  });

  it("目錄裡有的商品被標記忽略時，一樣不會進報表", async () => {
    /*
     * 這是最容易漏的一種：目錄 fallback 會解析出整份 CYBERBIZ 目錄（含已下架商品），
     * 所以「先問解析得出來嗎、再問有沒有被忽略」的順序會讓忽略完全失效——補寄與已下架
     * 正好都是目錄裡查得到的。
     */
    await db().insert(schema.cyberbizProducts).values({
      sku: "AGT0001", productId: "p-1", variantId: "v-1", productName: "提袋", variantName: "",
    });
    await db().insert(schema.reportSkuIgnores).values({
      id: "ignore-agt", channel: "cyberbiz", externalSku: "AGT0001", reason: "補寄用",
    });

    const response = await request(salesBody([
      salesRow("AGT0001", 100, { grossQuantity: 9, netQuantity: 9 }),
      salesRow("SKU-1", 200, { grossQuantity: 5, netQuantity: 5 }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: [] } });
    expect(await db().select({ sku: schema.reportSalesMonthly.sku }).from(schema.reportSalesMonthly))
      .toEqual([{ sku: "SKU-1" }]);
  });

  it("蝦皮以裸商品 ID 記下的忽略，擋得住帶規格 ID 的報表列", async () => {
    await db().insert(schema.reportSkuIgnores).values({
      id: "ignore-shopee", channel: "shopee", externalSku: "51210161926", reason: "補寄用",
    });
    await seedMapping({ id: "m-resend", channel: "shopee", externalSku: "51210161926_224686824526", components: [{ item: "item-sku-1" }] });

    const response = await request(shopeeBundle([
      salesRow("51210161926_224686824526", 0, { grossQuantity: 2, netQuantity: 2 }),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: [] } });
    expect(await db().select().from(schema.reportSalesMonthly)).toEqual([]);
  });

  it("補好對應之後重跑同一個月會把略過的補回來", async () => {
    expect((await request(salesBody([
      salesRow("LATE-001", 100, { grossQuantity: 3, netQuantity: 3 }),
      salesRow("SKU-1", 200, { grossQuantity: 5, netQuantity: 5 }),
    ]))).status).toBe(200);
    expect(await db().select().from(schema.reportSalesMonthly)).toHaveLength(1);

    await seedMapping({ id: "mapping-late", channel: "cyberbiz", externalSku: "LATE-001", components: [{ item: "item-sku-2" }] });

    expect((await request(salesBody([
      salesRow("LATE-001", 100, { grossQuantity: 3, netQuantity: 3 }),
      salesRow("SKU-1", 200, { grossQuantity: 5, netQuantity: 5 }),
    ]))).status).toBe(200);
    expect(await db().select({ sku: schema.reportSalesMonthly.sku })
      .from(schema.reportSalesMonthly).orderBy(schema.reportSalesMonthly.sku))
      .toEqual([{ sku: "SKU-1" }, { sku: "SKU-2" }]);
  });

  it("sales 全部未對應時 payout 仍照常保存", async () => {
    const response = await request(shopeeBundle(
      [salesRow("NOT-MAPPED", 100)],
      [{ businessDate: "2026-07-01", payoutAmount: 250 }],
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { skippedSkus: ["NOT-MAPPED"] } });
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
