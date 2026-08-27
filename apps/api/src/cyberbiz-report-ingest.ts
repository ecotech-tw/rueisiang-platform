import {
  insertReportPayoutDaily,
  insertReportSalesDaily,
  findReportScope,
  upsertReportScope,
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
  /**
   * 這批確實讀到報表的日期，包含當天零筆的情況。零筆的日子不會出現在 rows 裡，
   * 少了這份清單就無法與「當天匯出失敗」區分——後者的既有資料必須保留。
   * 舊版 runner 不會送，此時退回只清 rows 涵蓋的日期。
   */
  coveredDates?: string[];
  salesRows?: unknown[];
  payoutRows?: unknown[];
}

export class CyberbizReportIngestError extends Error {
  constructor(readonly status: 422, readonly code: "invalid_ingest") {
    super("CYBERBIZ 報表匯入資料格式不正確。");
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

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
  return value;
}

function optionalText(value: unknown, fallback: string): string {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return fallback;
  return text(value);
}

function readInput(value: unknown): CyberbizReportIngestInput {
  const isSingle = record(value) && (value.kind === "sales" || value.kind === "payout") && Array.isArray(value.rows);
  const isBundle = record(value) && value.kind === "sales_and_payout"
    && Array.isArray(value.salesRows) && Array.isArray(value.payoutRows);
  if (!record(value) || (!isSingle && !isBundle) || value.scopeType !== "store") {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  if (value.coveredDates !== undefined && !Array.isArray(value.coveredDates)) {
    throw new CyberbizReportIngestError(422, "invalid_ingest");
  }
  return {
    kind: value.kind as CyberbizReportIngestKind,
    scopeType: "store",
    scopeId: text(value.scopeId),
    scopeName: text(value.scopeName),
    ...(value.coveredDates ? { coveredDates: value.coveredDates.map(date) } : {}),
    ...(isSingle ? { rows: value.rows as unknown[] } : {}),
    ...(isBundle ? { salesRows: value.salesRows as unknown[], payoutRows: value.payoutRows as unknown[] } : {}),
  };
}

function salesRows(input: CyberbizReportIngestInput) {
  const rows = new Map<string, {
    scopeId: string;
    businessDate: string;
    sku: string;
    productName: string;
    category: string;
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
    updatedAt: string;
  }>();
  for (const value of input.rows ?? []) {
    if (!record(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
    const businessDate = date(value.businessDate);
    const sku = text(value.sku);
    const key = `${businessDate}\u0000${sku}`;
    const previous = rows.get(key);
    rows.set(key, {
      scopeId: input.scopeId,
      businessDate,
      sku,
      productName: optionalText(value.productName, previous?.productName ?? ""),
      category: optionalText(value.category, previous?.category ?? "未分類"),
      grossQuantity: (previous?.grossQuantity ?? 0) + integer(value.grossQuantity ?? 0),
      returnQuantity: (previous?.returnQuantity ?? 0) + integer(value.returnQuantity ?? 0),
      netQuantity: (previous?.netQuantity ?? 0) + integer(value.netQuantity ?? 0),
      salesAmount: (previous?.salesAmount ?? 0) + integer(value.salesAmount ?? 0),
      updatedAt: new Date().toISOString(),
    });
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
      const existingById = await findReportScope(db, { scopeKind: input.scopeType, id: input.scopeId });
      const nameMatch = existingById ?? (
        input.scopeId.startsWith("shopee:")
          ? null
          : await findReportScope(db, { scopeKind: input.scopeType, name: input.scopeName })
      );
      // 舊版 CYBERBIZ 設定可能使用任意 legacy ID，仍可依同名沿用；蝦皮則一定以自己的
      // scope ID 建立，不能因為名稱剛好相同而把資料寫進其他通路。
      const existing = existingById ?? (
        !input.scopeId.startsWith("shopee:") && nameMatch && !nameMatch.id.startsWith("shopee:")
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
        const sales = salesRows({ ...scopedInput, rows: input.salesRows ?? [] });
        const payout = payoutRows({ ...scopedInput, rows: input.payoutRows ?? [] });
        await insertReportSalesDaily(db, sales, scopedInput.coveredDates
          ? { scopeId: scope.id, dates: scopedInput.coveredDates }
          : undefined);
        await insertReportPayoutDaily(db, payout);
        return {
          kind: input.kind,
          scopeId: scope.id,
          rowCount: sales.length + payout.length,
          salesRowCount: sales.length,
          payoutRowCount: payout.length,
        };
      }
      if (input.kind === "sales") {
        const rows = salesRows(scopedInput);
        await insertReportSalesDaily(db, rows, scopedInput.coveredDates
          ? { scopeId: scope.id, dates: scopedInput.coveredDates }
          : undefined);
        return { kind: input.kind, scopeId: scope.id, rowCount: rows.length };
      }
      const rows = payoutRows(scopedInput);
      await insertReportPayoutDaily(db, rows);
      return { kind: input.kind, scopeId: scope.id, rowCount: rows.length };
    },
  };
}
