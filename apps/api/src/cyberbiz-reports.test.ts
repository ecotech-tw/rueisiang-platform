import { createDatabase, recordCyberbizReportManifest, syncSystemRoles } from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import type { NasStorageClient } from "./nas-storage.js";

let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

beforeEach(async () => {
  d1 = createLocalD1();
  await syncSystemRoles(db());
});

function document() {
  return {
    schemaVersion: 1 as const,
    kind: "cyberbiz_sales_monthly" as const,
    scopeType: "company" as const,
    scopeId: "company",
    scopeName: "公司整體",
    reportMonth: "2026-07",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    granularity: "month" as const,
    rows: [
      { sku: "SKU-1", productName: "商品一", category: "沐浴", unitPrice: 100, grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180 },
      { sku: "SKU-2", productName: "商品二", category: "食品", unitPrice: 50, grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 90 },
    ],
    totals: { grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 270 },
  };
}

function storeSalesDocument() {
  return {
    ...document(),
    scopeType: "store" as const,
    scopeId: "store-a",
    scopeName: "誠品西門店3F",
  };
}

async function publishCompanyReport() {
  await recordCyberbizReportManifest(db(), {
    reportMonth: "2026-07",
    scopeType: "company",
    scopeId: "company",
    scopeName: "公司整體",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    salesGranularity: "month",
    payoutGranularity: "day",
    salesObjectKey: "reports/cyberbiz/company/2026/07/00000000-0000-0000-0000-000000000001.json",
    payoutObjectKey: null,
    combinedWorkbookObjectKey: null,
    driveFileId: null,
    driveUrl: null,
    storeIdsJson: "[]",
    sourceChecksum: "checksum-company-2026-07",
    parserVersion: "cyberbiz-sales-v1",
    status: "published",
  });
}

async function publishCompanyPayout() {
  await recordCyberbizReportManifest(db(), {
    reportMonth: "2026-07",
    scopeType: "company",
    scopeId: "company",
    scopeName: "公司整體",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    salesGranularity: "month",
    payoutGranularity: "day",
    salesObjectKey: null,
    payoutObjectKey: "reports/cyberbiz/company/2026/07/00000000-0000-0000-0000-000000000002.json",
    combinedWorkbookObjectKey: null,
    driveFileId: null,
    driveUrl: null,
    storeIdsJson: "[]",
    sourceChecksum: "checksum-payout-company-2026-07",
    parserVersion: "cyberbiz-payout-v1",
    status: "published",
  });
}

async function publishStoreSalesAndPayoutManifests() {
  await recordCyberbizReportManifest(db(), {
    reportMonth: "2026-07",
    reportKind: "sales",
    scopeType: "store",
    scopeId: "store-a",
    scopeName: "誠品西門店3F",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    salesGranularity: "month",
    payoutGranularity: "day",
    salesObjectKey: "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000011.json",
    payoutObjectKey: null,
    combinedWorkbookObjectKey: null,
    driveFileId: "drive-sales",
    driveUrl: "https://drive.example.test/file/drive-sales",
    storeIdsJson: '["store-a"]',
    sourceChecksum: "checksum-store-sales-2026-07",
    parserVersion: "cyberbiz-sales-v1",
    status: "published",
  });
  await recordCyberbizReportManifest(db(), {
    reportMonth: "2026-07",
    reportKind: "payout",
    scopeType: "store",
    scopeId: "store-a",
    scopeName: "誠品西門店3F",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    salesGranularity: "month",
    payoutGranularity: "day",
    salesObjectKey: null,
    payoutObjectKey: "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000012.json",
    combinedWorkbookObjectKey: null,
    driveFileId: "drive-payout",
    driveUrl: "https://drive.example.test/file/drive-payout",
    storeIdsJson: '["store-a"]',
    sourceChecksum: "checksum-store-payout-2026-07",
    parserVersion: "cyberbiz-payout-v1",
    status: "published",
  });
}

describe("CYBERBIZ 報表查詢服務", () => {
  it("可用店面名稱查詢，並把 sales／payout manifest 合併成同一個 scope view", async () => {
    await publishStoreSalesAndPayoutManifests();
    const get = async () => new Response(JSON.stringify(storeSalesDocument()), { headers: { "content-type": "application/json" } });
    const nas = { get, put: async () => { throw new Error("not used"); }, delete: async () => {} } as unknown as NasStorageClient;
    const result = await createCyberbizReportService(db(), nas).querySales({
      reportMonth: "2026-07",
      scopeType: "store",
      scopeName: "誠品西門店 3F",
    });

    expect(result).toMatchObject({ status: "ok", scopeId: "store-a", scopeName: "誠品西門店3F" });
    if (result.status === "ok") {
      expect(result.manifest).toMatchObject({ scopeName: "誠品西門店3F", reportKind: "bundle" });
    }
  });

  it("公司整體查詢只讀一個預先彙總的 normalized JSON，分類也在同一個結果完成", async () => {
    await publishCompanyReport();
    const get = async () => new Response(JSON.stringify(document()), { headers: { "content-type": "application/json" } });
    const nas = { get, put: async () => { throw new Error("not used"); }, delete: async () => {} } as unknown as NasStorageClient;
    const result = await createCyberbizReportService(db(), nas).querySales({
      reportMonth: "2026-07",
      scopeType: "company",
      category: "沐浴",
    });

    expect(result).toMatchObject({ status: "ok", reportMonth: "2026-07" });
    if (result.status === "ok") {
      expect(result.rows).toHaveLength(1);
      expect(result.totals).toMatchObject({ netQuantity: 2, salesAmount: 180 });
    }
  });

  it("normalized JSON 的 scopeId 不符合 manifest 時拒絕回傳資料", async () => {
    await publishCompanyReport();
    const mismatched = { ...document(), scopeId: "store-b" };
    const nas = {
      get: async () => new Response(JSON.stringify(mismatched)),
      put: async () => { throw new Error("not used"); },
      delete: async () => {},
    } as unknown as NasStorageClient;

    await expect(createCyberbizReportService(db(), nas).querySales({
      reportMonth: "2026-07",
      scopeType: "company",
    })).rejects.toMatchObject({ code: "report_manifest_mismatch" });
  });

  it("非完整月份會先回傳 granularity 狀態，不會讀 NAS", async () => {
    let reads = 0;
    const nas = {
      get: async () => { reads += 1; return null; },
      put: async () => { throw new Error("not used"); },
      delete: async () => {},
    } as unknown as NasStorageClient;
    const result = await createCyberbizReportService(db(), nas).querySales({
      reportMonth: "2026-07",
      scopeType: "company",
      startDate: "2026-07-01",
      endDate: "2026-07-15",
    });

    expect(result.status).toBe("UNSUPPORTED_GRANULARITY");
    expect(reads).toBe(0);
  });

  it("沒有 manifest 時回傳 NO_DATA_FOR_RANGE", async () => {
    const nas = { get: async () => { throw new Error("should not read"); } } as unknown as NasStorageClient;
    const result = await createCyberbizReportService(db(), nas).querySales({ reportMonth: "2026-07", scopeType: "company" });
    expect(result.status).toBe("NO_DATA_FOR_RANGE");
  });

  it("出金查詢可對完整日區間做精確合計", async () => {
    await publishCompanyPayout();
    const payout = {
      schemaVersion: 1,
      kind: "cyberbiz_payout_daily",
      scopeType: "company",
      scopeId: "company",
      scopeName: "公司整體",
      reportMonth: "2026-07",
      coverageStart: "2026-07-01",
      coverageEnd: "2026-07-31",
      granularity: "day",
      rows: [
        { date: "2026-07-01", closeAt: "2026-07-01 21:00:00", incomeAmount: 100, incomeType: "現金", pos: "POS 1", operator: "甲" },
        { date: "2026-07-02", closeAt: "2026-07-02 21:00:00", incomeAmount: 200, incomeType: "信用卡", pos: "POS 1", operator: "乙" },
      ],
      totals: { incomeAmount: 300, rowCount: 2 },
    };
    const nas = {
      get: async () => new Response(JSON.stringify(payout)),
      put: async () => { throw new Error("not used"); },
      delete: async () => {},
    } as unknown as NasStorageClient;
    const result = await createCyberbizReportService(db(), nas).queryPayout({
      reportMonth: "2026-07",
      scopeType: "company",
      startDate: "2026-07-01",
      endDate: "2026-07-02",
    });
    expect(result).toMatchObject({ status: "ok", totals: { incomeAmount: 300, rowCount: 2 } });
  });

  it("payout normalized JSON 的 scopeId 不符合 manifest 時拒絕回傳資料", async () => {
    await publishCompanyPayout();
    const payout = {
      schemaVersion: 1,
      kind: "cyberbiz_payout_daily",
      scopeType: "company",
      scopeId: "store-b",
      scopeName: "公司整體",
      reportMonth: "2026-07",
      coverageStart: "2026-07-01",
      coverageEnd: "2026-07-31",
      granularity: "day",
      rows: [{ date: "2026-07-01", closeAt: "2026-07-01 21:00:00", incomeAmount: 100, incomeType: "現金", pos: "POS 1", operator: "甲" }],
      totals: { incomeAmount: 100, rowCount: 1 },
    };
    const nas = {
      get: async () => new Response(JSON.stringify(payout)),
      put: async () => { throw new Error("not used"); },
      delete: async () => {},
    } as unknown as NasStorageClient;

    await expect(createCyberbizReportService(db(), nas).queryPayout({
      reportMonth: "2026-07",
      scopeType: "company",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    })).rejects.toMatchObject({ code: "report_manifest_mismatch" });
  });
});
