import {
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  findReportScope,
  upsertReportScope,
  normalizeExternalSku,
  normalizeProductSkuChannel,
  resolveProductSkus,
  type Database,
  type ReportScopeKind,
} from "@rueisiang/db";

export type CyberbizReportIngestKind = "sales" | "payout" | "sales_and_payout";

export interface CyberbizReportIngestInput {
  kind: CyberbizReportIngestKind;
  scopeType: ReportScopeKind;
  scopeId: string;
  scopeName: string;
  rows?: unknown[];
  /** 商品銷售以整月快照匯入；出金仍由 rows 內的 businessDate 決定。 */
  reportMonth?: string;
  salesRows?: unknown[];
  payoutRows?: unknown[];
}

export class CyberbizReportIngestError extends Error {
  constructor(
    readonly status: 422,
    readonly code: "invalid_ingest" | "unmapped_product",
    message = code === "unmapped_product" ? "報表包含尚未對應的 WMS 商品。" : "CYBERBIZ 報表匯入資料格式不正確。",
  ) {
    super(message);
    this.name = "CyberbizReportIngestError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return value.trim();
}

function date(value: unknown): string {
  const result = text(value);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  return result;
}

function month(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result)) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return result;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return value;
}

function reportChannel(scopeId: string): string {
  const [prefix, scopePart] = scopeId.split(":", 2);
  if (!scopePart) return "legacy";
  return normalizeProductSkuChannel(prefix ?? "") || "legacy";
}

function readInput(value: unknown): CyberbizReportIngestInput {
  const isSingle = record(value) && (value.kind === "sales" || value.kind === "payout") && Array.isArray(value.rows);
  const isBundle = record(value) && value.kind === "sales_and_payout"
    && Array.isArray(value.salesRows) && Array.isArray(value.payoutRows);
  if (!record(value) || (!isSingle && !isBundle) || value.scopeType !== "store") {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  if ((value.kind === "sales" || value.kind === "sales_and_payout") && value.reportMonth !== undefined) {
    month(value.reportMonth);
  }
  if ((value.kind === "sales" || value.kind === "sales_and_payout")
    && value.reportMonth === undefined
    && (value.kind === "sales_and_payout" || (value.rows as unknown[]).length === 0)) {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  if (value.coveredDates !== undefined) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return {
    kind: value.kind as CyberbizReportIngestKind,
    scopeType: "store",
    scopeId: text(value.scopeId),
    scopeName: text(value.scopeName),
    ...(isSingle ? { rows: value.rows as unknown[] } : {}),
    ...(isBundle ? { salesRows: value.salesRows as unknown[], payoutRows: value.payoutRows as unknown[] } : {}),
    ...((value.kind === "sales" || value.kind === "sales_and_payout") && value.reportMonth !== undefined
      ? { reportMonth: month(value.reportMonth) }
      : {}),
  };
}

interface ParsedSalesRow {
  reportMonth: string;
  externalSku: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

function parseSalesRows(input: CyberbizReportIngestInput): ParsedSalesRow[] {
  const rows = new Map<string, {
    reportMonth: string;
    externalSku: string;
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
  }>();
  for (const value of input.rows ?? []) {
    if (!record(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
    if (value.businessDate !== undefined) throw new CyberbizReportIngestError(422, "invalid_ingest");
    const reportMonth = month(value.reportMonth ?? input.reportMonth);
    if (input.reportMonth && reportMonth !== input.reportMonth) {
      throw new CyberbizReportIngestError(422, "invalid_ingest");
    }
    const externalSku = normalizeExternalSku(text(value.sku));
    const key = `${reportMonth}\u0000${externalSku}`;
    const previous = rows.get(key);
    rows.set(key, {
      reportMonth,
      externalSku,
      grossQuantity: (previous?.grossQuantity ?? 0) + integer(value.grossQuantity ?? 0),
      returnQuantity: (previous?.returnQuantity ?? 0) + integer(value.returnQuantity ?? 0),
      netQuantity: (previous?.netQuantity ?? 0) + integer(value.netQuantity ?? 0),
      salesAmount: (previous?.salesAmount ?? 0) + integer(value.salesAmount ?? 0),
    });
  }
  return [...rows.values()];
}

async function normalizeSalesRows(
  db: Database,
  input: CyberbizReportIngestInput,
  channel = reportChannel(input.scopeId),
  // sales_and_payout 會先 parse 一次做格式驗證，把結果傳進來，省掉整份報表重複解析與彙總。
  preparsed?: ParsedSalesRow[],
): Promise<Array<{
  scopeId: string;
  reportMonth: string;
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  updatedAt: string;
}>> {
  const parsed = preparsed ?? parseSalesRows(input);
  if (!parsed.length) return [];

  const resolved = await resolveProductSkus(db, parsed.map((row) => row.externalSku), channel);

  const missing = parsed
    .map((row) => row.externalSku)
    .filter((sku, index, values) => !resolved.has(sku) && values.indexOf(sku) === index);
  if (missing.length) {
    throw new CyberbizReportIngestError(
      422,
      "unmapped_product",
      `以下外部 SKU 尚未對應 WMS 商品：${missing.slice(0, 50).join("、")}${missing.length > 50 ? "…" : ""}`,
    );
  }

  // 先 mapping 再加總：多個通路 SKU 可能對應同一個 WMS SKU，不能在外部 SKU 階段結束加總。
  // 只要有 components 就展開到實際 WMS SKU；組合包的銷售額只放在 mapping 的主商品，避免
  // 重複加總但仍保留整筆 CYBERBIZ 金額。蝦皮 salesAmount 本來就是 0，所以不會產生商品金額。
  const rows = new Map<string, {
    scopeId: string;
    reportMonth: string;
    sku: string;
    productName: string;
    category: string;
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
    updatedAt: string;
  }>();
  for (const row of parsed) {
    const item = resolved.get(row.externalSku)!;
    // 主商品不在用料裡時才退而求其次取第一個；resolveProductSkus 已依商品名稱排序料件，
    // 所以同一個月份重匯不會換一個料件收金額。
    const amountTargetId = item.components.some((component) => component.inventoryItemId === item.inventoryItemId)
      ? item.inventoryItemId
      : item.components[0]?.inventoryItemId;
    const targets = item.components.length
      ? item.components.map((component) => ({
        ...component,
        multiplier: component.quantity,
        allocatedSalesAmount: component.inventoryItemId === amountTargetId ? row.salesAmount : 0,
      }))
      : [{
        sku: item.sku,
        name: item.name,
        category: item.category,
        multiplier: 1,
        allocatedSalesAmount: row.salesAmount,
      }];
    for (const target of targets) {
      const key = `${row.reportMonth}\u0000${target.sku}`;
      const previous = rows.get(key);
      rows.set(key, {
        scopeId: input.scopeId,
        reportMonth: row.reportMonth,
        sku: target.sku,
        productName: target.name,
        category: target.category,
        grossQuantity: (previous?.grossQuantity ?? 0) + row.grossQuantity * target.multiplier,
        returnQuantity: (previous?.returnQuantity ?? 0) + row.returnQuantity * target.multiplier,
        netQuantity: (previous?.netQuantity ?? 0) + row.netQuantity * target.multiplier,
        salesAmount: (previous?.salesAmount ?? 0) + target.allocatedSalesAmount,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return [...rows.values()];
}

function payoutRows(input: CyberbizReportIngestInput) {
  const rows = new Map<string, { scopeId: string; businessDate: string; payoutAmount: number; updatedAt: string }>();
  for (const value of input.rows ?? []) {
    if (!record(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
    const businessDate = date(value.businessDate);
    const payoutAmount = integer(value.payoutAmount ?? 0);
    const previous = rows.get(businessDate);
    rows.set(businessDate, {
      scopeId: input.scopeId,
      businessDate,
      payoutAmount: (previous?.payoutAmount ?? 0) + payoutAmount,
      updatedAt: new Date().toISOString(),
    });
  }
  return [...rows.values()];
}

export function createCyberbizReportIngestor(db: Database) {
  return {
    async ingest(value: unknown): Promise<{ kind: CyberbizReportIngestKind; scopeId: string; rowCount: number; salesRowCount?: number; payoutRowCount?: number }> {
      const input = readInput(value);
      const sourceChannel = reportChannel(input.scopeId);
      const canReuseScopeByName = sourceChannel === "legacy" || sourceChannel === "cyberbiz";
      const existingById = await findReportScope(db, { scopeKind: input.scopeType, id: input.scopeId });
      const nameMatch = existingById ?? (
        !canReuseScopeByName
          ? null
          : await findReportScope(db, { scopeKind: input.scopeType, name: input.scopeName })
      );
      const nameMatchChannel = nameMatch ? reportChannel(nameMatch.id) : null;
      // 舊版 CYBERBIZ 設定可能使用任意 legacy ID，仍可依同名沿用；蝦皮則一定以自己的
      // scope ID 建立，不能因為名稱剛好相同而把資料寫進其他通路。
      const existing = existingById ?? (
        canReuseScopeByName
        && nameMatch
        && (nameMatchChannel === "legacy" || nameMatchChannel === sourceChannel)
          ? nameMatch
          : null
      );
      const scope = existing ?? await upsertReportScope(db, {
        id: input.scopeId,
        scopeKind: input.scopeType,
        name: input.scopeName,
      });
      const scopedInput = { ...input, scopeId: scope.id };
      if (input.kind === "sales_and_payout") {
        const salesInput = { ...scopedInput, rows: input.salesRows ?? [] };
        // 先驗證 sales 的資料格式，再寫入 payout；只有 mapping 不存在時才保留「先存 payout」的行為。
        const parsedSales = parseSalesRows(salesInput);
        const payout = payoutRows({ ...scopedInput, rows: input.payoutRows ?? [] });
        // payout 與商品 mapping 無關，先保存，避免新商品未 mapping 時連結帳金額也一起遺失。
        await insertReportPayoutDaily(db, payout);
        const sales = await normalizeSalesRows(db, salesInput, sourceChannel, parsedSales);
        await insertReportSalesMonthly(db, sales, input.reportMonth
          ? { scopeId: scope.id, reportMonth: input.reportMonth }
          : undefined);
        return {
          kind: input.kind,
          scopeId: scope.id,
          rowCount: sales.length + payout.length,
          salesRowCount: sales.length,
          payoutRowCount: payout.length,
        };
      }
      if (input.kind === "sales") {
        const rows = await normalizeSalesRows(db, scopedInput, sourceChannel);
        await insertReportSalesMonthly(db, rows, input.reportMonth
          ? { scopeId: scope.id, reportMonth: input.reportMonth }
          : undefined);
        return { kind: input.kind, scopeId: scope.id, rowCount: rows.length };
      }
      const rows = payoutRows(scopedInput);
      await insertReportPayoutDaily(db, rows);
      return { kind: input.kind, scopeId: scope.id, rowCount: rows.length };
    },
  };
}
