import path from "node:path";
import { readSheet } from "../payout/parser.mjs";

const REQUIRED_HEADERS = [
  "SKU",
  "商品名稱",
  "銷售數量",
  "退回數量",
  "淨銷售數量",
  "售額總計",
];

function text(value) {
  return value == null ? "" : String(value).trim();
}

function number(value, label) {
  if (value == null || text(value) === "") return 0;
  const normalized = text(value).replace(/,/g, "").replace(/%$/, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是有效數字：${text(value)}`);
  return parsed;
}

function cents(value) {
  return Math.round(value * 100);
}

function dateRange(value) {
  const match = /([0-9]{4}-[0-9]{2}-[0-9]{2})\s+[^~]+~\s+([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(text(value));
  if (!match) throw new Error(`找不到銷售總表的日期區間：${text(value) || "空白"}`);
  return { start: match[1], end: match[2] };
}

function findColumn(columns, name, required = true) {
  const index = columns.indexOf(name);
  if (index < 0 && required) throw new Error(`銷售總表缺少欄位：${name}`);
  return index;
}

function cell(cells, column, row) {
  return column < 0 ? undefined : cells.get(`${String.fromCharCode(65 + column)}${row}`);
}

function assertRowTotals(rows, totals, field, label) {
  const actual = rows.reduce((sum, row) => sum + row[field], 0);
  if (cents(actual) !== cents(totals[field])) {
    throw new Error(`銷售總表 ${label} 合計不一致：明細 ${actual}、總計 ${totals[field]}`);
  }
}

/**
 * 解析「商品銷售總表」的指定區間。CYBERBIZ 報表是區間彙總；driver 以每日區間
 * 執行時，這些列即可作為 D1 的每日事實資料。
 * 售額一律採用 J 欄的售額總計，不用售價乘數量重算，以保留折扣、組合商品與贈品的語意。
 */
export async function parseSalesReport(filePath, {
  scopeType = "store",
  scopeId,
  scopeName = "",
  reportMonth,
  start,
  end,
  allowEmpty = false,
  parserVersion = "cyberbiz-sales-v1",
} = {}) {
  if (!scopeId || !/^[A-Za-z0-9._:-]{1,100}$/.test(scopeId)) throw new Error("scopeId 必須是安全的識別碼。");
  if (scopeType !== "store" && scopeType !== "company") throw new Error("scopeType 必須是 store 或 company。");

  const { cells, maxRow } = await readSheet(filePath);
  const range = dateRange(cells.get("A1"));
  const detectedMonth = range.start.slice(0, 7);
  if (start && end && (range.start !== start || range.end !== end)) {
    const error = new Error(`商品銷售總表日期區間 ${range.start} ~ ${range.end} 與指定區間 ${start} ~ ${end} 不一致。`);
    error.code = "RANGE_MISMATCH";
    throw error;
  }
  if (range.end.slice(0, 7) !== detectedMonth) throw new Error("銷售總表不能跨月份。");
  if (reportMonth && reportMonth !== detectedMonth) {
    const error = new Error(`檔案月份 ${detectedMonth} 與指定月份 ${reportMonth} 不一致。`);
    error.code = "RANGE_MISMATCH";
    throw error;
  }

  const columns = [];
  for (let column = 0; column < 26; column += 1) columns.push(text(cell(cells, column, 2)));
  for (const header of REQUIRED_HEADERS) findColumn(columns, header);

  const skuColumn = findColumn(columns, "SKU");
  const productColumn = findColumn(columns, "商品名稱");
  const categoryColumn = findColumn(columns, "類別", false);
  const grossQuantityColumn = findColumn(columns, "銷售數量");
  const returnQuantityColumn = findColumn(columns, "退回數量");
  const netQuantityColumn = findColumn(columns, "淨銷售數量");
  const salesAmountColumn = findColumn(columns, "售額總計");

  let totalRow = -1;
  for (let row = 3; row <= maxRow; row += 1) {
    if (text(cells.get(`A${row}`)) === "總計") {
      totalRow = row;
      break;
    }
  }
  if (totalRow < 0) throw new Error("銷售總表缺少總計列。");

  const rows = [];
  for (let row = 3; row < totalRow; row += 1) {
    const sku = text(cell(cells, skuColumn, row));
    if (!sku) continue;
    rows.push({
      sku,
      productName: text(cell(cells, productColumn, row)),
      category: text(cell(cells, categoryColumn, row)) || "未分類",
      grossQuantity: number(cell(cells, grossQuantityColumn, row), `第 ${row} 列銷售數量`),
      returnQuantity: number(cell(cells, returnQuantityColumn, row), `第 ${row} 列退回數量`),
      netQuantity: number(cell(cells, netQuantityColumn, row), `第 ${row} 列淨銷售數量`),
      salesAmount: number(cell(cells, salesAmountColumn, row), `第 ${row} 列售額總計`),
    });
  }
  if (!rows.length && !allowEmpty) {
    const error = new Error("銷售總表沒有商品明細。");
    error.code = "EMPTY_REPORT";
    throw error;
  }

  const totals = {
    grossQuantity: number(cell(cells, grossQuantityColumn, totalRow), "總計銷售數量"),
    returnQuantity: number(cell(cells, returnQuantityColumn, totalRow), "總計退回數量"),
    netQuantity: number(cell(cells, netQuantityColumn, totalRow), "總計淨銷售數量"),
    salesAmount: number(cell(cells, salesAmountColumn, totalRow), "總計售額"),
  };
  assertRowTotals(rows, totals, "grossQuantity", "銷售數量");
  assertRowTotals(rows, totals, "returnQuantity", "退回數量");
  assertRowTotals(rows, totals, "netQuantity", "淨銷售數量");
  assertRowTotals(rows, totals, "salesAmount", "售額");

  return {
    schemaVersion: 1,
    kind: "cyberbiz_sales_interval",
    scopeType,
    scopeId,
    scopeName: scopeName || path.basename(filePath),
    reportMonth: detectedMonth,
    coverageStart: range.start,
    coverageEnd: range.end,
    granularity: range.start === range.end ? "day" : "interval",
    rows,
    totals,
    source: { filename: path.basename(filePath), parserVersion },
  };
}

