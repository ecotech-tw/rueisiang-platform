import type { WorkBook } from "xlsx";
import * as XLSX from "xlsx";

export interface NormalizedSalesRow {
  reportMonth: string;
  sku: string;
  productName: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface SalesTotals {
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface MonthlySalesTotals extends SalesTotals {
  reportMonth: string;
}

export interface DailyPayoutRow {
  businessDate: string;
  payoutAmount: number;
}

export interface ParsedSalesReport {
  sourceType: "momo";
  sourceSheet: string;
  rows: NormalizedSalesRow[];
  payoutRows: DailyPayoutRow[];
  payoutTotal: number;
  reportMonths: string[];
  monthlyTotals: MonthlySalesTotals[];
  salesTotals: SalesTotals;
  sourceRowCount: number;
  skippedRowCount: number;
  fallbackSkuCount: number;
  warnings: string[];
}

export interface ReportParser<FileInput = File> {
  readonly sourceType: string;
  readonly formats: readonly string[];
  parse(file: FileInput): Promise<ParsedSalesReport>;
}

function cellText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").trim();
}

function normalizeHeader(value: unknown): string {
  return cellText(value).replace(/[\s\r\n]/gu, "");
}

function dateFromValue(value: unknown): string {
  const text = cellText(value);
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : "";
}

function monthFromDate(value: unknown): string {
  return dateFromValue(value).slice(0, 7);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  const text = cellText(value).replace(/[,$\s]/gu, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requireSheet(workbook: WorkBook, name: string): XLSX.WorkSheet {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`找不到「${name}」工作表，請確認上傳的是 Mo+ 對帳明細。`);
  return sheet;
}

function headerIndex(headers: string[], names: readonly string[]): number {
  return headers.findIndex((header) => names.includes(header));
}

function parseRows(workbook: WorkBook): ParsedSalesReport {
  requireSheet(workbook, "訂單彙總");
  const sheetName = "訂單明細";
  const sheet = requireSheet(workbook, sheetName);
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
  const headerRowIndex = matrix.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return ["訂單確認日（出貨日）", "訂單確認日(出貨日)"].some((name) => headers.includes(name))
      && headers.includes("商品原廠編號")
      && headers.includes("商品編號")
      && headers.includes("商品名稱")
      && headers.includes("數量")
      && headers.includes("入帳日")
      && headers.includes("實際入帳金額");
  });
  if (headerRowIndex < 0) throw new Error("「訂單明細」缺少必要欄位（訂單確認日、商品欄位、入帳日或實際入帳金額）。");

  const headers = (matrix[headerRowIndex] ?? []).map(normalizeHeader);
  const columns = {
    orderDate: headerIndex(headers, ["訂單確認日（出貨日）", "訂單確認日(出貨日)"]),
    businessDate: headerIndex(headers, ["入帳日"]),
    payoutAmount: headerIndex(headers, ["實際入帳金額"]),
    quantity: headerIndex(headers, ["數量"]),
    unitPrice: headerIndex(headers, ["單筆售價"]),
    discount: headerIndex(headers, ["總折扣金額"]),
    productCode: headerIndex(headers, ["商品編號"]),
    productName: headerIndex(headers, ["商品名稱"]),
    manufacturerCode: headerIndex(headers, ["商品原廠編號"]),
    status: headerIndex(headers, ["訂單狀態"]),
  };
  if (columns.unitPrice < 0 || columns.discount < 0 || columns.status < 0) {
    throw new Error("「訂單明細」缺少售價、折扣或訂單狀態欄位，無法安全匯入。");
  }

  const grouped = new Map<string, NormalizedSalesRow>();
  const payoutByDate = new Map<string, number>();
  const skippedStatuses = new Map<string, number>();
  let unassignedPayoutRowCount = 0;
  let unassignedPayoutTotal = 0;
  let sourceRowCount = 0;
  let skippedRowCount = 0;
  let fallbackSkuCount = 0;

  for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] ?? [];
    if (!row.some((value) => cellText(value))) continue;
    const sourceRow = rowIndex + 1;
    sourceRowCount += 1;
    const businessDateText = cellText(row[columns.businessDate]);
    const payoutAmountText = cellText(row[columns.payoutAmount]);
    if (businessDateText || payoutAmountText) {
      const payoutAmount = numberValue(payoutAmountText);
      if (payoutAmount === null) throw new Error(`「訂單明細」第 ${sourceRow} 列的入帳日或實際入帳金額格式錯誤。`);
      if (!businessDateText) {
        // Mo+ 的回收／取消列可能有負的實際入帳金額，卻沒有入帳日；不拿出貨日代替結算日。
        if (payoutAmount !== 0) {
          unassignedPayoutRowCount += 1;
          unassignedPayoutTotal += payoutAmount;
          if (!Number.isSafeInteger(unassignedPayoutTotal)) throw new Error(`「訂單明細」第 ${sourceRow} 列的未歸日出金金額超出安全範圍。`);
        }
      } else {
        const businessDate = dateFromValue(businessDateText);
        if (!businessDate) throw new Error(`「訂單明細」第 ${sourceRow} 列的入帳日或實際入帳金額格式錯誤。`);
        const nextAmount = (payoutByDate.get(businessDate) ?? 0) + payoutAmount;
        if (!Number.isSafeInteger(nextAmount)) throw new Error(`「訂單明細」第 ${sourceRow} 列的每日出金金額超出安全範圍。`);
        payoutByDate.set(businessDate, nextAmount);
      }
    }
    const productName = cellText(row[columns.productName]);
    const manufacturerCode = cellText(row[columns.manufacturerCode]);
    const productCode = cellText(row[columns.productCode]);
    // Mo+ 將運費列放在訂單明細中；它不是商品，不應出現在 SKU mapping 待處理清單。
    if (productName.includes("運費")) {
      skippedRowCount += 1;
      continue;
    }
    const status = cellText(row[columns.status]);
    const isReturn = ["已退貨", "退貨完成", "退貨已完成"].includes(status);
    if (status !== "已送達" && !isReturn) {
      skippedRowCount += 1;
      skippedStatuses.set(status || "未填訂單狀態", (skippedStatuses.get(status || "未填訂單狀態") ?? 0) + 1);
      continue;
    }
    const sku = manufacturerCode || productCode;
    const reportMonth = monthFromDate(row[columns.orderDate]);
    const quantity = numberValue(row[columns.quantity]);
    const unitPrice = numberValue(row[columns.unitPrice]);
    const discountText = cellText(row[columns.discount]);
    const discount = discountText ? numberValue(discountText) : 0;
    if (!sku || !productName || !reportMonth || quantity === null || quantity <= 0 || unitPrice === null || discount === null) {
      throw new Error(`「訂單明細」第 ${sourceRow} 列有缺少或格式錯誤的商品資料。`);
    }
    if (!manufacturerCode) fallbackSkuCount += 1;

    const signedQuantity = isReturn ? -quantity : quantity;
    const signedAmount = (unitPrice * quantity - discount) * (isReturn ? -1 : 1);
    if (!Number.isSafeInteger(signedAmount)) throw new Error(`「訂單明細」第 ${sourceRow} 列金額超出安全範圍。`);
    const key = `${reportMonth}\u0000${sku.toLocaleUpperCase("zh-TW")}`;
    const previous = grouped.get(key);
    grouped.set(key, {
      reportMonth,
      sku,
      productName: previous?.productName ?? productName,
      grossQuantity: (previous?.grossQuantity ?? 0) + (isReturn ? 0 : quantity),
      returnQuantity: (previous?.returnQuantity ?? 0) + (isReturn ? quantity : 0),
      netQuantity: (previous?.netQuantity ?? 0) + signedQuantity,
      salesAmount: (previous?.salesAmount ?? 0) + signedAmount,
    });
  }

  if (!grouped.size && !payoutByDate.size) throw new Error("「訂單明細」沒有可匯入的銷售或出金資料列。");
  const rows = [...grouped.values()].sort((left, right) => left.reportMonth.localeCompare(right.reportMonth) || left.sku.localeCompare(right.sku));
  const payoutRows = [...payoutByDate.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([businessDate, payoutAmount]) => ({ businessDate, payoutAmount }));
  const payoutTotal = payoutRows.reduce((total, row) => total + row.payoutAmount, 0);
  if (!Number.isSafeInteger(payoutTotal)) throw new Error("Mo+ 對帳明細的出金總額超出安全範圍。");
  const monthlyTotals = new Map<string, SalesTotals>();
  for (const row of rows) {
    const totals = monthlyTotals.get(row.reportMonth) ?? { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 };
    totals.grossQuantity += row.grossQuantity;
    totals.returnQuantity += row.returnQuantity;
    totals.netQuantity += row.netQuantity;
    totals.salesAmount += row.salesAmount;
    monthlyTotals.set(row.reportMonth, totals);
  }
  const monthlySummary = [...monthlyTotals.entries()].map(([reportMonth, totals]) => ({ reportMonth, ...totals }));
  const salesTotals = monthlySummary.reduce((total, month) => ({
    grossQuantity: total.grossQuantity + month.grossQuantity,
    returnQuantity: total.returnQuantity + month.returnQuantity,
    netQuantity: total.netQuantity + month.netQuantity,
    salesAmount: total.salesAmount + month.salesAmount,
  }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 });
  const warnings = [...skippedStatuses.entries()].map(([status, count]) => `略過 ${count} 列「${status}」訂單狀態。`);
  if (unassignedPayoutRowCount) {
    warnings.push(`${unassignedPayoutRowCount} 列有實際入帳金額但沒有「入帳日」（合計 NT$${unassignedPayoutTotal.toLocaleString("zh-TW")}），無法歸入每日出金，已略過。`);
  }
  if (fallbackSkuCount) warnings.push(`${fallbackSkuCount} 列沒有商品原廠編號，將改用商品編號進行對應。`);
  return {
    sourceType: "momo",
    sourceSheet: sheetName,
    rows,
    payoutRows,
    payoutTotal,
    reportMonths: monthlySummary.map(({ reportMonth }) => reportMonth),
    monthlyTotals: monthlySummary,
    salesTotals,
    sourceRowCount,
    skippedRowCount,
    fallbackSkuCount,
    warnings,
  };
}

export const momoReportParser: ReportParser = {
  sourceType: "momo",
  formats: [".xls", ".xlsx"],
  async parse(file) {
    if (!/\.xlsx?$/iu.test(file.name)) throw new Error("Mo+ 對帳明細僅接受 .xls 或 .xlsx 檔案。");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    return parseRows(workbook);
  },
};

export function parseMomoWorkbook(buffer: ArrayBuffer): ParsedSalesReport {
  return parseRows(XLSX.read(buffer, { type: "array", cellDates: true }));
}
