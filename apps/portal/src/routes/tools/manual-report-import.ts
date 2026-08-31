import { toAmount, toBusinessDate, type Sheet } from "./xlsx.js";

export const PAYOUT_HEADER_ROWS = [1, 2, 3] as const;

const DATE_HINTS = ["關帳時間", "關帳日期", "日期", "營業日"];
const AMOUNT_HINTS = ["公司POS", "收入金額", "百貨POS", "營業額", "銷售金額", "金額"];
const TOTAL_HINTS = ["總計", "合計", "小計", "Total"];

export interface PayoutHeader {
  column: string;
  label: string;
}

export interface PayoutDetected {
  headerRow: number;
  dateColumn: string;
  amountColumn: string;
  headers: PayoutHeader[];
}

export interface PayoutDayRow {
  businessDate: string;
  payoutAmount: number;
  rowCount: number;
}

export interface PayoutPreview {
  days: PayoutDayRow[];
  skipped: number[];
  total: number;
}

function isTotalRow(sheet: Sheet, row: number): boolean {
  return sheet.columns.some((column) => {
    const value = sheet.cells.get(`${column}${row}`);
    return typeof value === "string" && TOTAL_HINTS.some((hint) => value.includes(hint));
  });
}

function isValidBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function payoutHeaders(sheet: Sheet, headerRow: number): PayoutHeader[] {
  return sheet.columns
    .map((column) => ({ column, label: String(sheet.cells.get(`${column}${headerRow}`) ?? "").trim() }))
    .filter((entry) => entry.label);
}

/** 找出出金報表的標題列、日期欄與優先使用的金額欄。 */
export function detectPayout(sheet: Sheet): PayoutDetected | null {
  for (const headerRow of PAYOUT_HEADER_ROWS) {
    const headers = payoutHeaders(sheet, headerRow);
    if (headers.length < 2) continue;
    const dateColumn = headers.find((entry) => DATE_HINTS.some((hint) => entry.label.includes(hint)))?.column;
    if (!dateColumn) continue;
    const amountColumn = AMOUNT_HINTS
      .flatMap((hint) => headers.filter((entry) => entry.label.includes(hint)))
      .find((entry) => {
        if (entry.column === dateColumn) return false;
        return !entry.label.includes("公司POS")
          || summarisePayout(sheet, headerRow, dateColumn, entry.column).days.length > 0;
      })?.column;
    if (amountColumn) return { headerRow, dateColumn, amountColumn, headers };
  }
  return null;
}

/** 將合併儲存格日期向前／向後補齊，再按日期彙總出金金額。 */
export function summarisePayout(
  sheet: Sheet,
  headerRow: number,
  dateColumn: string,
  amountColumn: string,
): PayoutPreview {
  interface RawRow {
    row: number;
    date: string;
    amount: number | null;
    hasAmount: boolean;
  }
  const raws: RawRow[] = [];
  for (let row = headerRow + 1; row <= sheet.maxRow; row += 1) {
    const rawDate = sheet.cells.get(`${dateColumn}${row}`);
    const rawAmount = sheet.cells.get(`${amountColumn}${row}`);
    if (rawDate === undefined && rawAmount === undefined) continue;
    if (isTotalRow(sheet, row)) continue;
    const parsedDate = toBusinessDate(rawDate);
    raws.push({
      row,
      date: isValidBusinessDate(parsedDate) ? parsedDate : "",
      amount: rawAmount === undefined ? null : toAmount(rawAmount),
      hasAmount: rawAmount !== undefined,
    });
  }

  // 公司POS 的陣列公式會把總計放在最後一筆資料的下一列，日期仍是空白。
  const trailing = raws.at(-1);
  const amountLabel = String(sheet.cells.get(`${amountColumn}${headerRow}`) ?? "");
  if (trailing && !trailing.date && trailing.amount !== null && amountLabel.includes("公司POS")) {
    const previousTotal = raws.slice(0, -1).reduce((sum, raw) => sum + (raw.amount ?? 0), 0);
    if (Math.abs(previousTotal - trailing.amount) < 0.01) raws.pop();
  }

  let carried = "";
  for (const raw of raws) {
    if (raw.date) carried = raw.date;
    else raw.date = carried;
  }
  let upcoming = "";
  for (let index = raws.length - 1; index >= 0; index -= 1) {
    const raw = raws[index];
    if (!raw) continue;
    if (raw.date) upcoming = raw.date;
    else raw.date = upcoming;
  }

  const byDate = new Map<string, PayoutDayRow>();
  const skipped: number[] = [];
  for (const raw of raws) {
    // 公司POS 只有關帳列有值，其他空白金額列是正常格式。
    if (!raw.hasAmount) continue;
    if (!raw.date || raw.amount === null || !Number.isSafeInteger(Math.round(raw.amount))) {
      skipped.push(raw.row);
      continue;
    }
    const amount = Math.round(raw.amount);
    const existing = byDate.get(raw.date);
    if (existing) {
      existing.payoutAmount += amount;
      existing.rowCount += 1;
    } else {
      byDate.set(raw.date, { businessDate: raw.date, payoutAmount: amount, rowCount: 1 });
    }
  }
  const days = [...byDate.values()].sort((left, right) => left.businessDate.localeCompare(right.businessDate));
  return { days, skipped, total: days.reduce((sum, day) => sum + day.payoutAmount, 0) };
}

export interface SalesImportRow {
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface SalesImportTotals {
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface SalesImportPreview {
  reportMonth: string;
  coverageStart: string;
  coverageEnd: string;
  rows: SalesImportRow[];
  skippedRows: number[];
  totals: SalesImportTotals;
  totalRow: number;
}

const SALES_REQUIRED_HEADERS = [
  "SKU",
  "商品名稱",
  "銷售數量",
  "退回數量",
  "淨銷售數量",
  "售額總計",
] as const;

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function salesCell(sheet: Sheet, column: number, row: number): string | number | undefined {
  return sheet.cells.get(`${columnName(column)}${row}`);
}

function salesText(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

function salesNumber(value: string | number | undefined, label: string): number {
  if (value === undefined || salesText(value) === "") return 0;
  const normalized = salesText(value).replace(/,/gu, "").replace(/%$/u, "");
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} 不是有效的整數：${salesText(value)}`);
  return parsed;
}

function salesDateRange(value: string | number | undefined): { start: string; end: string } {
  const match = /(\d{4}-\d{2}-\d{2})\s+[^~]+~\s+(\d{4}-\d{2}-\d{2})/u.exec(salesText(value));
  if (!match || !isValidBusinessDate(match[1] ?? "") || !isValidBusinessDate(match[2] ?? "")) {
    throw new Error(`找不到商品銷售報表的日期區間：${salesText(value) || "空白"}`);
  }
  return { start: match[1]!, end: match[2]! };
}

function isWholeMonth(range: { start: string; end: string }): boolean {
  if (range.start !== `${range.start.slice(0, 7)}-01`) return false;
  const [year, month] = range.end.slice(0, 7).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return range.end === `${range.end.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

function findSalesColumn(columns: string[], name: string, required = true): number {
  const index = columns.indexOf(name);
  if (index < 0 && required) throw new Error(`商品銷售報表缺少欄位：${name}`);
  return index;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function assertSalesTotals(
  rows: SalesImportRow[],
  skippedRows: Array<SalesImportRow & { row: number }>,
  totals: SalesImportTotals,
  field: keyof SalesImportTotals,
  label: string,
): void {
  const actual = rows.reduce((sum, row) => sum + row[field], 0);
  const skipped = skippedRows.reduce((sum, row) => sum + row[field], 0);
  if (cents(actual + skipped) !== cents(totals[field])) {
    throw new Error(`商品銷售報表 ${label} 合計不一致：明細 ${actual}、總計 ${totals[field]}`);
  }
}

/** 解析 CYBERBIZ 商品銷售總表，保留 SKU 與報表列的原始商品資訊。 */
export function parseSalesSheet(sheet: Sheet): SalesImportPreview {
  const range = salesDateRange(salesCell(sheet, 0, 1));
  if (range.start.slice(0, 7) !== range.end.slice(0, 7)) throw new Error("商品銷售報表不能跨月份。");
  if (!isWholeMonth(range)) throw new Error("商品銷售報表必須是完整月份，才能匯入報表管理。");

  const columns = Array.from({ length: 26 }, (_, index) => salesText(salesCell(sheet, index, 2)));
  for (const header of SALES_REQUIRED_HEADERS) findSalesColumn(columns, header);
  const skuColumn = findSalesColumn(columns, "SKU");
  const productColumn = findSalesColumn(columns, "商品名稱");
  const categoryColumn = findSalesColumn(columns, "類別", false);
  const grossQuantityColumn = findSalesColumn(columns, "銷售數量");
  const returnQuantityColumn = findSalesColumn(columns, "退回數量");
  const netQuantityColumn = findSalesColumn(columns, "淨銷售數量");
  const salesAmountColumn = findSalesColumn(columns, "售額總計");

  let totalRow = -1;
  for (let row = 3; row <= sheet.maxRow; row += 1) {
    if (salesText(salesCell(sheet, 0, row)) === "總計") {
      totalRow = row;
      break;
    }
  }
  if (totalRow < 0) throw new Error("商品銷售報表缺少總計列。");

  const rows: SalesImportRow[] = [];
  const skippedRows: Array<SalesImportRow & { row: number }> = [];
  for (let row = 3; row < totalRow; row += 1) {
    const sku = salesText(salesCell(sheet, skuColumn, row)).toUpperCase();
    const quantities = {
      grossQuantity: salesNumber(salesCell(sheet, grossQuantityColumn, row), `第 ${row} 列銷售數量`),
      returnQuantity: salesNumber(salesCell(sheet, returnQuantityColumn, row), `第 ${row} 列退回數量`),
      netQuantity: salesNumber(salesCell(sheet, netQuantityColumn, row), `第 ${row} 列淨銷售數量`),
      salesAmount: salesNumber(salesCell(sheet, salesAmountColumn, row), `第 ${row} 列售額總計`),
    };
    if (!sku) {
      if (Object.values(quantities).some((value) => value !== 0)) skippedRows.push({ row, sku: "", productName: "", category: "", ...quantities });
      continue;
    }
    rows.push({
      sku,
      productName: salesText(salesCell(sheet, productColumn, row)) || sku,
      category: salesText(salesCell(sheet, categoryColumn, row)) || "未分類",
      ...quantities,
    });
  }
  if (!rows.length) throw new Error("商品銷售報表沒有商品明細。");

  const totals = {
    grossQuantity: salesNumber(salesCell(sheet, grossQuantityColumn, totalRow), "總計銷售數量"),
    returnQuantity: salesNumber(salesCell(sheet, returnQuantityColumn, totalRow), "總計退回數量"),
    netQuantity: salesNumber(salesCell(sheet, netQuantityColumn, totalRow), "總計淨銷售數量"),
    salesAmount: salesNumber(salesCell(sheet, salesAmountColumn, totalRow), "總計售額"),
  };
  assertSalesTotals(rows, skippedRows, totals, "grossQuantity", "銷售數量");
  assertSalesTotals(rows, skippedRows, totals, "returnQuantity", "退回數量");
  assertSalesTotals(rows, skippedRows, totals, "netQuantity", "淨銷售數量");
  assertSalesTotals(rows, skippedRows, totals, "salesAmount", "售額");

  const bySku = new Map<string, SalesImportRow>();
  for (const row of rows) {
    const previous = bySku.get(row.sku);
    if (!previous) {
      bySku.set(row.sku, row);
      continue;
    }
    previous.grossQuantity += row.grossQuantity;
    previous.returnQuantity += row.returnQuantity;
    previous.netQuantity += row.netQuantity;
    previous.salesAmount += row.salesAmount;
  }
  return {
    reportMonth: range.start.slice(0, 7),
    coverageStart: range.start,
    coverageEnd: range.end,
    rows: [...bySku.values()],
    skippedRows: skippedRows.map((row) => row.row),
    totals,
    totalRow,
  };
}
