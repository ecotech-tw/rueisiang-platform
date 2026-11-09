import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseMomoWorkbook } from "./report-adapter.js";

function workbookBuffer(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["NO", "訂單確認日（出貨日）", "入帳日", "單筆售價", "數量", "總折扣金額", "商品編號", "商品名稱", "商品原廠編號", "訂單狀態", "實際入帳金額"],
    [1, "2026/09/16", "2026/10/02", 500, 2, 10, "TP-1", "測試商品", "ASO-1", "已送達", 457],
    [2, "2026/09/17", "2026/10/02", 500, 1, 0, "TP-1", "測試商品", "ASO-1", "已退貨", 528],
    [3, "2026/09/18", "2026/10/02", 80, 1, 0, "SHIP-1", "運費", "", "已送達", 0],
    [4, "2026/10/01", "", 300, 1, 0, "TP-2", "無原廠編號商品", "", "處理中", ""],
    [5, "2026/10/02", "2026/10/03", 300, 1, 0, "TP-2", "無原廠編號商品", "", "已送達", 250],
    [6, "2026/10/03", "2026/10/04", 300, 1, 0, "TP-2", "無原廠編號商品", "", "退貨申請中", 25],
  ]), "訂單明細");
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

describe("Mo+ 對帳明細 parser", () => {
  it("解析訂單明細、優先取原廠編號並彙總月份商品數量", () => {
    const parsed = parseMomoWorkbook(workbookBuffer());
    expect(parsed).toMatchObject({
      sourceType: "momo",
      sourceSheet: "訂單明細",
      reportMonths: ["2026-09", "2026-10"],
      sourceRowCount: 6,
      skippedRowCount: 3,
      payoutRows: [
        { businessDate: "2026-10-02", payoutAmount: 985 },
        { businessDate: "2026-10-03", payoutAmount: 250 },
        { businessDate: "2026-10-04", payoutAmount: 25 },
      ],
      payoutTotal: 1260,
      fallbackSkuCount: 1,
      salesTotals: { grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 790 },
      monthlyTotals: [
        { reportMonth: "2026-09", grossQuantity: 2, returnQuantity: 1, netQuantity: 1, salesAmount: 490 },
        { reportMonth: "2026-10", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 300 },
      ],
      rows: [
        { reportMonth: "2026-09", sku: "ASO-1", grossQuantity: 2, returnQuantity: 1, netQuantity: 1, salesAmount: 490 },
        { reportMonth: "2026-10", sku: "TP-2", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 300 },
      ],
    });
    expect(parsed.warnings).toContain("1 列沒有商品原廠編號，將改用商品編號進行對應。");
    expect(parsed.warnings).toContain("略過 1 列「退貨申請中」訂單狀態。");
  });

  it("即使沒有符合銷售狀態的商品列，仍可預覽有實際入帳的每日出金", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["NO", "訂單確認日（出貨日）", "入帳日", "單筆售價", "數量", "總折扣金額", "商品編號", "商品名稱", "商品原廠編號", "訂單狀態", "實際入帳金額"],
      [1, "2026/10/01", "2026/10/02", 100, 1, 0, "TP-1", "測試商品", "ASO-1", "處理中", 80],
    ]), "訂單明細");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    const parsed = parseMomoWorkbook(buffer);
    expect(parsed.rows).toEqual([]);
    expect(parsed.payoutRows).toEqual([{ businessDate: "2026-10-02", payoutAmount: 80 }]);
  });

  it("沒有入帳日的非零金額不推測日期，略過出金並在預覽警告", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["NO", "訂單確認日（出貨日）", "入帳日", "單筆售價", "數量", "總折扣金額", "商品編號", "商品名稱", "商品原廠編號", "訂單狀態", "實際入帳金額"],
      [1, "2026/10/01", "2026/10/02", 100, 1, 0, "TP-1", "測試商品", "ASO-1", "已送達", 80],
      [2, "2026/10/03", "", 100, 1, 0, "TP-2", "回收商品", "ASO-2", "回收確認", -47],
      [3, "2026/10/04", "", 100, 1, 0, "TP-3", "待處理商品", "ASO-3", "處理中", 0],
      [4, "", "", "", "", "", "", "", "", "取消訂單通知", -2],
    ]), "訂單明細");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    const parsed = parseMomoWorkbook(buffer);

    expect(parsed.payoutRows).toEqual([{ businessDate: "2026-10-02", payoutAmount: 80 }]);
    expect(parsed.payoutTotal).toBe(80);
    expect(parsed.warnings).toContain("2 列有實際入帳金額但沒有「入帳日」（合計 NT$-49），無法歸入每日出金，已略過。");
    expect(parsed.warnings).toContain("略過 1 列「回收確認」訂單狀態。");
    expect(parsed.warnings).toContain("略過 1 列「取消訂單通知」訂單狀態。");
  });

  it("缺少每日出金欄位時拒絕匯入", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["訂單確認日（出貨日）", "商品原廠編號", "商品編號", "商品名稱", "數量"],
    ]), "訂單明細");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    expect(() => parseMomoWorkbook(buffer)).toThrow("缺少必要欄位");
  });

  it("缺少訂單明細工作表或必要欄位時拒絕匯入", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["訂單號碼"]]), "訂單彙總");
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    expect(() => parseMomoWorkbook(buffer)).toThrow("找不到「訂單明細」工作表");
  });
});
