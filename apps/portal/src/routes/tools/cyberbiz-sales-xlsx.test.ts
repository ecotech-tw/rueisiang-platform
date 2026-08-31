import { describe, expect, it } from "vitest";
import { parseManualCyberbizSales } from "./cyberbiz-sales-xlsx.js";
import type { CellValue, Sheet } from "./xlsx.js";

/**
 * 商品銷售總表的解析。
 *
 * 這份測試的存在理由是「完整月份」那道守門曾在解合併衝突時被整段刪掉而沒有人發現
 * （710f42f）：寫入是先刪掉該據點該月份全部再寫入，半個月或跨月的檔案會靜默清掉資料。
 */

const HEADERS = ["SKU", "商品名稱", "類別", "銷售數量", "退回數量", "淨銷售數量", "售額總計"];
const COLUMNS = ["A", "B", "C", "D", "E", "F", "G"];

/** 組一份最小的標準格式工作表：A1 是日期區間，第 2 列是表頭，之後一列商品加一列總計。 */
function standardSheet(range: string): Sheet {
  const cells = new Map<string, CellValue>([["A1", range]]);
  HEADERS.forEach((header, index) => cells.set(`${COLUMNS[index]}2`, header));
  const product = ["SKU-001", "測試商品", "未分類", 3, 1, 2, 250];
  product.forEach((value, index) => cells.set(`${COLUMNS[index]}3`, value));
  const total = ["總計", "", "", 3, 1, 2, 250];
  total.forEach((value, index) => cells.set(`${COLUMNS[index]}4`, value));
  return { cells, maxRow: 4, columns: COLUMNS };
}

describe("商品銷售總表的日期區間", () => {
  it("完整月份可以解析，reportMonth 取自區間", () => {
    const preview = parseManualCyberbizSales(standardSheet("2026-07-01 00:00 ~ 2026-07-31 23:59"));

    expect(preview).toMatchObject({
      format: "standard",
      reportMonth: "2026-07",
      coverageStart: "2026-07-01",
      coverageEnd: "2026-07-31",
    });
    expect(preview.rows).toMatchObject([{ sku: "SKU-001", netQuantity: 2, salesAmount: 250 }]);
  });

  it.each([
    ["月中開始", "2026-07-05 00:00 ~ 2026-07-31 23:59"],
    ["月底之前結束", "2026-07-01 00:00 ~ 2026-07-10 23:59"],
  ])("不收不完整的月份（%s），否則會清掉該月剩下的日子", (_label, range) => {
    expect(() => parseManualCyberbizSales(standardSheet(range)))
      .toThrowError("手動匯入商品銷售必須使用完整月份的檔案（從 1 號到月底）。");
  });

  it("不收跨月份的檔案，否則起月會被整個清掉", () => {
    expect(() => parseManualCyberbizSales(standardSheet("2026-07-20 00:00 ~ 2026-08-05 23:59")))
      .toThrowError("商品銷售總表不能跨月份，請上傳單一完整月份的檔案。");
  });

  it("二月依實際天數判斷月底", () => {
    expect(parseManualCyberbizSales(standardSheet("2026-02-01 00:00 ~ 2026-02-28 23:59")).reportMonth).toBe("2026-02");
    expect(() => parseManualCyberbizSales(standardSheet("2026-02-01 00:00 ~ 2026-02-27 23:59")))
      .toThrowError("手動匯入商品銷售必須使用完整月份的檔案（從 1 號到月底）。");
  });
});
