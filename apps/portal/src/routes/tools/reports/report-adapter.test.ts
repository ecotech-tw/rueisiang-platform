import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseMoPlusWorkbook } from "./report-adapter.js";

function workbookBuffer(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["NO", "訂單確認日（出貨日）", "單筆售價", "數量", "總折扣金額", "商品編號", "商品名稱", "商品原廠編號", "訂單狀態"],
    [1, "2026/09/16", 500, 2, 10, "TP-1", "測試商品", "ASO-1", "已送達"],
    [2, "2026/09/17", 500, 1, 0, "TP-1", "測試商品", "ASO-1", "已退貨"],
    [3, "2026/09/18", 80, 1, 0, "SHIP-1", "運費", "", "已送達"],
    [4, "2026/10/01", 300, 1, 0, "TP-2", "無原廠編號商品", "", "處理中"],
    [5, "2026/10/02", 300, 1, 0, "TP-2", "無原廠編號商品", "", "已送達"],
  ]), "訂單明細");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

describe("Mo+ 對帳明細 parser", () => {
  it("解析訂單明細、優先取原廠編號並彙總月份商品數量", () => {
    const parsed = parseMoPlusWorkbook(workbookBuffer());
    expect(parsed).toMatchObject({
      sourceType: "mo_plus",
      sourceSheet: "訂單明細",
      reportMonths: ["2026-09", "2026-10"],
      sourceRowCount: 5,
      skippedRowCount: 2,
      fallbackSkuCount: 1,
      rows: [
        { reportMonth: "2026-09", sku: "ASO-1", grossQuantity: 2, returnQuantity: 1, netQuantity: 1, salesAmount: 490 },
        { reportMonth: "2026-10", sku: "TP-2", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 300 },
      ],
    });
    expect(parsed.warnings).toContain("1 列沒有商品原廠編號，將改用商品編號進行對應。");
  });

  it("缺少訂單明細工作表或必要欄位時拒絕匯入", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    expect(() => parseMoPlusWorkbook(buffer)).toThrow("找不到「訂單明細」工作表");
  });
});
