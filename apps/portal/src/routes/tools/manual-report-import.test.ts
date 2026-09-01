import { describe, expect, it } from "vitest";
import {
  parseStandardImportCsv,
  parseStandardImportSheet,
} from "./manual-report-import.js";
import type { CellValue, Sheet } from "./xlsx.js";

describe("報表管理標準匯入格式", () => {
  it("解析出金 CSV 並保留每一列資料", () => {
    const preview = parseStandardImportCsv("payout", "\uFEFF出金日期,出金金額\r\n2026-08-01,\"1,200\"\r\n2026-08-02,500\r\n");

    expect(preview).toMatchObject({
      kind: "payout",
      coverageStart: "2026-08-01",
      coverageEnd: "2026-08-02",
      total: 1700,
    });
    expect(preview.kind === "payout" ? preview.rows : []).toEqual([
      { sourceRow: 2, businessDate: "2026-08-01", payoutAmount: 1200 },
      { sourceRow: 3, businessDate: "2026-08-02", payoutAmount: 500 },
    ]);
  });

  it("解析商品銷售 CSV 的全部欄位，且允許跨月份", () => {
    const preview = parseStandardImportCsv(
      "sales",
      [
        "報表月份,SKU,商品名稱,類別,銷售數量,退回數量,淨銷售數量,售額總計",
        "2026-08,SKU-001,\"夏季,商品\",清潔,3,1,2,250",
        "2026-09,SKU-002,另一商品,日用品,5,0,5,900",
      ].join("\n"),
    );

    expect(preview).toMatchObject({
      kind: "sales",
      reportMonths: ["2026-08", "2026-09"],
      totals: { grossQuantity: 8, returnQuantity: 1, netQuantity: 7, salesAmount: 1150 },
    });
    expect(preview.kind === "sales" ? preview.rows[0] : undefined).toMatchObject({
      reportMonth: "2026-08",
      sku: "SKU-001",
      productName: "夏季,商品",
      category: "清潔",
      grossQuantity: 3,
      returnQuantity: 1,
      netQuantity: 2,
      salesAmount: 250,
    });
  });

  it("拒絕不符合指定欄位順序的檔案", () => {
    expect(() => parseStandardImportCsv("payout", "日期,金額\n2026-08-01,100\n"))
      .toThrowError("檔案第 1 列必須完全符合指定格式");
  });

  it("XLSX 儲存格也使用同一套嚴格格式與欄位驗證", () => {
    const cells = new Map<string, CellValue>([
      ["A1", "報表月份"], ["B1", "SKU"], ["C1", "商品名稱"], ["D1", "類別"],
      ["E1", "銷售數量"], ["F1", "退回數量"], ["G1", "淨銷售數量"], ["H1", "售額總計"],
      ["A2", "2026-08"], ["B2", "SKU-X"], ["C2", "測試商品"], ["D2", "測試"],
      ["E2", 1], ["F2", 0], ["G2", 1], ["H2", 80],
    ]);
    const sheet: Sheet = { cells, maxRow: 2, columns: ["A", "B", "C", "D", "E", "F", "G", "H"] };

    expect(parseStandardImportSheet("sales", sheet)).toMatchObject({
      kind: "sales",
      rows: [{ reportMonth: "2026-08", sku: "SKU-X", salesAmount: 80 }],
    });
  });
});
