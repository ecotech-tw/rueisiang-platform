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
