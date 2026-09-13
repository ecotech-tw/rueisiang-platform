import { readFirstSheet, toAmount, toBusinessDate, type CellValue, type Sheet } from "./xlsx.js";

const PAYOUT_TEMPLATE_HEADERS = ["出金日期", "出金金額"] as const;
const SALES_TEMPLATE_HEADERS = [
  "報表月份",
  "SKU",
  "商品名稱",
  "類別",
  "銷售數量",
  "退回數量",
  "淨銷售數量",
  "售額總計",
] as const;

export interface StandardPayoutImportRow {
  sourceRow: number;
  businessDate: string;
  payoutAmount: number;
}

export interface StandardSalesImportRow {
  sourceRow: number;
  reportMonth: string;
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

interface StandardPayoutImportPreview {
  kind: "payout";
  rows: StandardPayoutImportRow[];
  total: number;
  coverageStart: string;
  coverageEnd: string;
}

interface StandardSalesImportPreview {
  kind: "sales";
  rows: StandardSalesImportRow[];
  reportMonths: string[];
  totals: {
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
  };
}

export type StandardImportPreview = StandardPayoutImportPreview | StandardSalesImportPreview;

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

function columnNumber(column: string): number {
  return [...column].reduce((result, character) => result * 26 + character.charCodeAt(0) - 64, 0);
}

function cellText(value: CellValue | undefined): string {
  return typeof value === "string"
    ? value.replace(/^\uFEFF/u, "").trim()
    : value === undefined ? "" : String(value).trim();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(value);
}

function safeAdd(current: number, next: number, label: string): number {
  const total = current + next;
  if (!Number.isSafeInteger(total)) throw new Error(`${label}加總超出可安全儲存的整數範圍。`);
  return total;
}

function parseInteger(value: CellValue | undefined, row: number, label: string): number {
  const parsed = toAmount(value);
  if (parsed === null || !Number.isSafeInteger(parsed)) {
    throw new Error(`第 ${row} 列的${label}必須是安全整數。`);
  }
  return parsed;
}

function parseRequiredText(value: CellValue | undefined, row: number, label: string): string {
  const parsed = cellText(value);
  if (!parsed) throw new Error(`第 ${row} 列缺少${label}。`);
  return parsed;
}

function parseHeaders(kind: "payout" | "sales", sheet: Sheet): number {
  const expected = kind === "payout" ? PAYOUT_TEMPLATE_HEADERS : SALES_TEMPLATE_HEADERS;
  const actual = expected.map((_, index) => cellText(sheet.cells.get(`${columnName(index)}1`)));
  const extraColumns = sheet.columns
    .filter((column) => columnNumber(column) > expected.length)
    .filter((column) => [...Array(sheet.maxRow).keys()].some((row) => sheet.cells.has(`${column}${row + 1}`)));
  if (actual.some((value, index) => value !== expected[index]) || extraColumns.length) {
    throw new Error(`檔案第 1 列必須完全符合指定格式：${expected.join("、")}。`);
  }
  return expected.length;
}

function isBlankRow(sheet: Sheet, row: number, columnCount: number): boolean {
  return Array.from({ length: columnCount }, (_, index) => cellText(sheet.cells.get(`${columnName(index)}${row}`))).every((value) => !value);
}

function parsePayoutSheet(sheet: Sheet): StandardPayoutImportPreview {
  const columnCount = parseHeaders("payout", sheet);
  const rows: StandardPayoutImportRow[] = [];
  for (let row = 2; row <= sheet.maxRow; row += 1) {
    if (isBlankRow(sheet, row, columnCount)) continue;
    const businessDate = toBusinessDate(sheet.cells.get(`A${row}`));
    if (!validDate(businessDate)) throw new Error(`第 ${row} 列的出金日期格式不正確，請使用 YYYY-MM-DD。`);
    rows.push({
      sourceRow: row,
      businessDate,
      payoutAmount: parseInteger(sheet.cells.get(`B${row}`), row, "出金金額"),
    });
  }
  if (!rows.length) throw new Error("檔案中沒有可匯入的出金資料。");
  const dates = rows.map((row) => row.businessDate).sort();
  return {
    kind: "payout",
    rows,
    total: rows.reduce((total, row) => safeAdd(total, row.payoutAmount, "出金金額"), 0),
    coverageStart: dates[0] ?? "",
    coverageEnd: dates.at(-1) ?? "",
  };
}

function parseSalesSheet(sheet: Sheet): StandardSalesImportPreview {
  const columnCount = parseHeaders("sales", sheet);
  const rows: StandardSalesImportRow[] = [];
  for (let row = 2; row <= sheet.maxRow; row += 1) {
    if (isBlankRow(sheet, row, columnCount)) continue;
    const reportMonth = parseRequiredText(sheet.cells.get(`A${row}`), row, "報表月份");
    if (!validMonth(reportMonth)) throw new Error(`第 ${row} 列的報表月份格式不正確，請使用 YYYY-MM。`);
    rows.push({
      sourceRow: row,
      reportMonth,
      sku: parseRequiredText(sheet.cells.get(`B${row}`), row, "SKU"),
      productName: cellText(sheet.cells.get(`C${row}`)),
      category: cellText(sheet.cells.get(`D${row}`)) || "未分類",
      grossQuantity: parseInteger(sheet.cells.get(`E${row}`), row, "銷售數量"),
      returnQuantity: parseInteger(sheet.cells.get(`F${row}`), row, "退回數量"),
      netQuantity: parseInteger(sheet.cells.get(`G${row}`), row, "淨銷售數量"),
      salesAmount: parseInteger(sheet.cells.get(`H${row}`), row, "售額總計"),
    });
  }
  if (!rows.length) throw new Error("檔案中沒有可匯入的商品銷售資料。");
  const totals = rows.reduce((current, row) => ({
    grossQuantity: safeAdd(current.grossQuantity, row.grossQuantity, "銷售數量"),
    returnQuantity: safeAdd(current.returnQuantity, row.returnQuantity, "退回數量"),
    netQuantity: safeAdd(current.netQuantity, row.netQuantity, "淨銷售數量"),
    salesAmount: safeAdd(current.salesAmount, row.salesAmount, "售額總計"),
  }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 });
  return {
    kind: "sales",
    rows,
    reportMonths: [...new Set(rows.map((row) => row.reportMonth))].sort(),
    totals,
  };
}

export function parseStandardImportSheet(kind: "payout" | "sales", sheet: Sheet): StandardImportPreview {
  return kind === "payout" ? parsePayoutSheet(sheet) : parseSalesSheet(sheet);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && !value) {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.endsWith("\r") ? value.slice(0, -1) : value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("CSV 檔案的引號格式不正確。");
  if (value || row.length) {
    row.push(value.endsWith("\r") ? value.slice(0, -1) : value);
    rows.push(row);
  }
  return rows;
}

export function parseStandardImportCsv(kind: "payout" | "sales", text: string): StandardImportPreview {
  const rows = parseCsv(text);
  const maxColumns = Math.max(...rows.map((row) => row.length), 0);
  const cells = new Map<string, CellValue>();
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (value !== "") cells.set(`${columnName(columnIndex)}${rowIndex + 1}`, value);
  }));
  return parseStandardImportSheet(kind, {
    cells,
    maxRow: rows.length,
    columns: Array.from({ length: maxColumns }, (_, index) => columnName(index)),
  });
}

export async function parseStandardImportFile(file: File, kind: "payout" | "sales"): Promise<StandardImportPreview> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || file.type === "text/csv") {
    return parseStandardImportCsv(kind, await file.text());
  }
  if (!name.endsWith(".xlsx")) throw new Error("只支援指定格式的 CSV 或 XLSX 檔案。");
  return parseStandardImportSheet(kind, await readFirstSheet(file));
}
