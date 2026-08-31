import { toAmount, type CellValue, type Sheet } from "./xlsx.js";

const HEADER_ROWS = [1, 2, 3, 4, 5];
const REQUIRED_HEADERS = [
  "SKU",
  "商品名稱",
  "銷售數量",
  "退回數量",
  "淨銷售數量",
  "售額總計",
] as const;
const LEGACY_REQUIRED_HEADERS = ["商品名稱", "淨銷售數量"] as const;

export type ManualSalesFormat = "standard" | "legacy-net-quantity";

interface SalesNumbers {
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface ManualSalesRow extends SalesNumbers {
  sourceRow: number;
  sku: string;
  productName: string;
  category: string;
}

export interface ManualSalesCatalogProduct {
  sku: string;
  name: string;
  published: boolean;
  aliases?: string[];
}

export interface ManualSalesPreview {
  format: ManualSalesFormat;
  headerRow: number;
  reportMonth: string;
  coverageStart: string;
  coverageEnd: string;
  rows: ManualSalesRow[];
  skippedRows: number[];
  unresolvedProductNames: string[];
  totals: SalesNumbers;
}

function text(value: CellValue | undefined): string {
  return value === undefined ? "" : String(value).trim();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normaliseDate(value: string): string {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (!match) return "";
  const [, year, month, day] = match;
  const result = `${year}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
  return validDate(result) ? result : "";
}

function readDateRange(sheet: Sheet): { start: string; end: string } {
  const header = text(sheet.cells.get("A1"));
  const match = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+[^~]*~\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/.exec(header);
  const start = match ? normaliseDate(match[1] ?? "") : "";
  const end = match ? normaliseDate(match[2] ?? "") : "";
  if (!start || !end) {
    throw new Error(`找不到商品銷售總表的日期區間：${header || "空白"}`);
  }
  if (start > end) throw new Error("商品銷售總表日期起日不可晚於迄日。");
  return { start, end };
}

function findHeaders(sheet: Sheet): { row: number; columns: Map<string, string>; format: ManualSalesFormat } {
  for (const row of HEADER_ROWS) {
    const columns = new Map<string, string>();
    for (const column of sheet.columns) {
      const label = text(sheet.cells.get(`${column}${row}`));
      if (label && !columns.has(label)) columns.set(label, column);
    }
    if (REQUIRED_HEADERS.every((header) => columns.has(header))) {
      return { row, columns, format: "standard" };
    }
    if (LEGACY_REQUIRED_HEADERS.every((header) => columns.has(header))) {
      return { row, columns, format: "legacy-net-quantity" };
    }
  }
  throw new Error(
    `找不到商品銷售總表欄位；標準格式需要 ${REQUIRED_HEADERS.join("、")}，舊版合併檔需要 ${LEGACY_REQUIRED_HEADERS.join("、")}。`,
  );
}

function findTotalRow(sheet: Sheet, headerRow: number, totalColumn?: string): number {
  if (totalColumn) {
    for (let row = headerRow + 1; row <= sheet.maxRow; row += 1) {
      if (text(sheet.cells.get(`${totalColumn}${row}`)) === "總計") return row;
    }
    throw new Error("舊版合併檔的商品銷售區段缺少總計列。");
  }
  for (let row = headerRow + 1; row <= sheet.maxRow; row += 1) {
    if (sheet.columns.some((column) => text(sheet.cells.get(`${column}${row}`)) === "總計")) return row;
  }
  throw new Error("商品銷售總表缺少總計列。");
}

function number(sheet: Sheet, column: string, row: number, label: string): { value: number; present: boolean } {
  const raw = sheet.cells.get(`${column}${row}`);
  if (raw === undefined || text(raw) === "") return { value: 0, present: false };
  const value = toAmount(raw);
  if (value === null) throw new Error(`第 ${row} 列${label}不是有效數字：${text(raw)}`);
  return { value, present: true };
}

function integer(value: number, label: string): number {
  const result = Math.round(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出可安全匯入的整數範圍。`);
  return result;
}

function add(left: SalesNumbers, right: SalesNumbers): SalesNumbers {
  return {
    grossQuantity: left.grossQuantity + right.grossQuantity,
    returnQuantity: left.returnQuantity + right.returnQuantity,
    netQuantity: left.netQuantity + right.netQuantity,
    salesAmount: left.salesAmount + right.salesAmount,
  };
}

function assertTotals(rows: SalesNumbers[], skipped: SalesNumbers[], totals: SalesNumbers): void {
  const actual = add(rows.reduce((sum, row) => add(sum, row), zero()), skipped.reduce((sum, row) => add(sum, row), zero()));
  for (const field of Object.keys(totals) as (keyof SalesNumbers)[]) {
    if (Math.round(actual[field] * 100) !== Math.round(totals[field] * 100)) {
      const labels: Record<keyof SalesNumbers, string> = {
        grossQuantity: "銷售數量",
        returnQuantity: "退回數量",
        netQuantity: "淨銷售數量",
        salesAmount: "售額",
      };
      throw new Error(`商品銷售總表 ${labels[field]} 合計不一致：明細 ${actual[field]}、總計 ${totals[field]}`);
    }
  }
}

function zero(): SalesNumbers {
  return { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 };
}

function parseLegacyNetQuantitySales(
  sheet: Sheet,
  headerRow: number,
  columns: Map<string, string>,
  start: string,
  end: string,
): ManualSalesPreview {
  const productColumn = columns.get("商品名稱")!;
  const quantityColumn = columns.get("淨銷售數量")!;
  const totalRow = findTotalRow(sheet, headerRow, productColumn);
  const sourceRows: ManualSalesRow[] = [];
  const sourceValues: SalesNumbers[] = [];
  const skippedRows: number[] = [];
  const skippedValues: SalesNumbers[] = [];
  let numericCellCount = 0;

  for (let row = headerRow + 1; row < totalRow; row += 1) {
    const quantity = number(sheet, quantityColumn, row, "淨銷售數量");
    numericCellCount += quantity.present ? 1 : 0;
    const netQuantity = integer(quantity.value, `第 ${row} 列淨銷售數量`);
    const productName = text(sheet.cells.get(`${productColumn}${row}`));
    const values = {
      // 舊檔只留下淨銷售數量；為了讓既有 sales schema 能保存，銷售數量沿用淨數量。
      grossQuantity: netQuantity,
      returnQuantity: 0,
      netQuantity,
      salesAmount: 0,
    } satisfies SalesNumbers;
    if (!productName) {
      if (netQuantity !== 0) {
        skippedRows.push(row);
        skippedValues.push(values);
      }
      continue;
    }
    sourceValues.push(values);
    sourceRows.push({
      sourceRow: row,
      sku: "",
      productName,
      category: "未分類",
      ...values,
    });
  }

  const totalQuantity = number(sheet, quantityColumn, totalRow, "總計淨銷售數量");
  numericCellCount += totalQuantity.present ? 1 : 0;
  if (numericCellCount === 0) {
    throw new Error("讀不到舊版合併檔的淨銷售數量；請確認檔案沒有被 Excel 公式清空，或另存新檔後再上傳。");
  }
  const totals = {
    grossQuantity: totalQuantity.value,
    returnQuantity: 0,
    netQuantity: totalQuantity.value,
    salesAmount: 0,
  } satisfies SalesNumbers;
  assertTotals(sourceValues, skippedValues, totals);
  if (!sourceRows.some((row) => row.netQuantity !== 0)) {
    throw new Error("舊版合併檔沒有可匯入的淨銷售數量。");
  }

  return {
    format: "legacy-net-quantity",
    headerRow,
    reportMonth: start.slice(0, 7),
    coverageStart: start,
    coverageEnd: end,
    rows: sourceRows,
    skippedRows,
    unresolvedProductNames: [],
    totals: {
      grossQuantity: integer(totals.grossQuantity, "總計銷售數量"),
      returnQuantity: 0,
      netQuantity: integer(totals.netQuantity, "總計淨銷售數量"),
      salesAmount: 0,
    },
  };
}

/** 解析 CYBERBIZ「商品銷售總表」；只回傳預覽需要的資料，不直接碰 API。 */
export function parseManualCyberbizSales(sheet: Sheet): ManualSalesPreview {
  const { start, end } = readDateRange(sheet);
  const { row: headerRow, columns, format } = findHeaders(sheet);
  if (format === "legacy-net-quantity") {
    return parseLegacyNetQuantitySales(sheet, headerRow, columns, start, end);
  }
  const totalRow = findTotalRow(sheet, headerRow);
  const skuColumn = columns.get("SKU")!;
  const productColumn = columns.get("商品名稱")!;
  const categoryColumn = columns.get("類別");
  const numericColumns = {
    grossQuantity: columns.get("銷售數量")!,
    returnQuantity: columns.get("退回數量")!,
    netQuantity: columns.get("淨銷售數量")!,
    salesAmount: columns.get("售額總計")!,
  } satisfies Record<keyof SalesNumbers, string>;

  const sourceRows: ManualSalesRow[] = [];
  const sourceValues: SalesNumbers[] = [];
  const skippedRows: number[] = [];
  const skippedValues: SalesNumbers[] = [];
  let numericCellCount = 0;

  for (let row = headerRow + 1; row < totalRow; row += 1) {
    const values = {
      grossQuantity: number(sheet, numericColumns.grossQuantity, row, "銷售數量"),
      returnQuantity: number(sheet, numericColumns.returnQuantity, row, "退回數量"),
      netQuantity: number(sheet, numericColumns.netQuantity, row, "淨銷售數量"),
      salesAmount: number(sheet, numericColumns.salesAmount, row, "售額總計"),
    };
    numericCellCount += Object.values(values).filter((entry) => entry.present).length;
    const numbers = {
      grossQuantity: values.grossQuantity.value,
      returnQuantity: values.returnQuantity.value,
      netQuantity: values.netQuantity.value,
      salesAmount: values.salesAmount.value,
    };
    const sku = text(sheet.cells.get(`${skuColumn}${row}`));
    if (!sku) {
      if (Object.values(numbers).some((value) => value !== 0)) {
        skippedRows.push(row);
        skippedValues.push(numbers);
      }
      continue;
    }
    sourceValues.push(numbers);
    sourceRows.push({
      sourceRow: row,
      sku,
      productName: text(sheet.cells.get(`${productColumn}${row}`)),
      category: text(categoryColumn ? sheet.cells.get(`${categoryColumn}${row}`) : undefined) || "未分類",
      grossQuantity: integer(numbers.grossQuantity, `第 ${row} 列銷售數量`),
      returnQuantity: integer(numbers.returnQuantity, `第 ${row} 列退回數量`),
      netQuantity: integer(numbers.netQuantity, `第 ${row} 列淨銷售數量`),
      salesAmount: integer(numbers.salesAmount, `第 ${row} 列售額總計`),
    });
  }

  const totalValues = {
    grossQuantity: number(sheet, numericColumns.grossQuantity, totalRow, "總計銷售數量"),
    returnQuantity: number(sheet, numericColumns.returnQuantity, totalRow, "總計退回數量"),
    netQuantity: number(sheet, numericColumns.netQuantity, totalRow, "總計淨銷售數量"),
    salesAmount: number(sheet, numericColumns.salesAmount, totalRow, "總計售額"),
  };
  numericCellCount += Object.values(totalValues).filter((entry) => entry.present).length;
  if (numericCellCount === 0) {
    throw new Error("讀不到商品銷售數字；如果檔案是由公式產生，請先在 Excel 另存新檔後再上傳。");
  }
  const totals = {
    grossQuantity: totalValues.grossQuantity.value,
    returnQuantity: totalValues.returnQuantity.value,
    netQuantity: totalValues.netQuantity.value,
    salesAmount: totalValues.salesAmount.value,
  };
  assertTotals(sourceValues, skippedValues, totals);
  if (!sourceRows.length) throw new Error("商品銷售總表沒有可匯入的商品明細。");

  return {
    format: "standard",
    headerRow,
    reportMonth: start.slice(0, 7),
    coverageStart: start,
    coverageEnd: end,
    rows: sourceRows,
    skippedRows,
    unresolvedProductNames: [],
    totals: {
      grossQuantity: integer(totals.grossQuantity, "總計銷售數量"),
      returnQuantity: integer(totals.returnQuantity, "總計退回數量"),
      netQuantity: integer(totals.netQuantity, "總計淨銷售數量"),
      salesAmount: integer(totals.salesAmount, "總計售額"),
    },
  };
}

function productNameKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").trim().toLocaleLowerCase("zh-TW");
}

/** 舊檔的品名可能在末尾多一個「 - 」，規格也可能用半形括號或連字號表示。 */
function productNameKeys(value: string): string[] {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const aliases = new Set([normalized]);
  const withoutTrailingSeparator = normalized.replace(/\s*[-‐‑‒–—―－]\s*$/, "").trim();
  if (withoutTrailingSeparator !== normalized) aliases.add(withoutTrailingSeparator);

  const separated = /^(.+?)\s*[-‐‑‒–—―－]\s*(.+)$/.exec(withoutTrailingSeparator);
  if (separated) {
    const [, base, variant] = separated;
    if (base && variant) {
      aliases.add(`${base}（${variant}）`);
      aliases.add(`${base}(${variant})`);
    }
  }

  const parenthesized = /^(.+?)[(（](.*)[)）]$/.exec(withoutTrailingSeparator);
  if (parenthesized) {
    const [, base, variant] = parenthesized;
    if (base && variant) {
      // 舊版報表有時只帶商品主名稱，目錄則會把唯一規格附在括號裡。
      // 先建立 base alias；若同一商品有多個規格，resolver 仍會因候選不唯一而要求人工確認。
      aliases.add(base);
      aliases.add(`${base} - ${variant}`);
      aliases.add(`${base}-${variant}`);
    }
  }
  return [...aliases].map(productNameKey).filter(Boolean);
}

/** 把舊檔只有品名的列，對到同步過的 CYBERBIZ 商品目錄 SKU。 */
export function resolveManualSalesPreview(
  preview: ManualSalesPreview,
  products: ManualSalesCatalogProduct[],
): ManualSalesPreview {
  if (preview.format !== "legacy-net-quantity") return preview;

  const byName = new Map<string, ManualSalesCatalogProduct[]>();
  for (const product of products) {
    for (const name of [product.name, ...(product.aliases ?? [])]) {
      for (const key of productNameKeys(name)) {
        const list = byName.get(key) ?? [];
        if (!list.some((candidate) => candidate.sku === product.sku)) list.push(product);
        byName.set(key, list);
      }
    }
  }

  const unresolved = new Set<string>();
  const rows = preview.rows.map((row) => {
    // 保留預覽中手動輸入或覆寫的 SKU；商品目錄只負責填補空白欄位。
    const manualSku = row.sku.trim();
    if (manualSku) {
      return manualSku === row.sku ? row : { ...row, sku: manualSku };
    }
    const candidates = [...new Map(
      productNameKeys(row.productName)
        .flatMap((key) => byName.get(key) ?? [])
        .map((product) => [product.sku, product] as const),
    ).values()];
    if (candidates.length === 1) return { ...row, sku: candidates[0]!.sku };
    if (row.netQuantity !== 0) unresolved.add(row.productName);
    return row;
  });

  return {
    ...preview,
    rows,
    unresolvedProductNames: [...unresolved],
  };
}
