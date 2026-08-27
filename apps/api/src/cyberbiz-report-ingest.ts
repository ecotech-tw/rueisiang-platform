import {
  insertReportPayoutDaily,
  insertReportSalesMonthly,
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
  /** 商品銷售以整月快照匯入；出金仍由 rows 內的 businessDate 決定。 */
  reportMonth?: string;
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

function month(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result)) throw new CyberbizReportIngestError(422, "invalid_ingest");
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

function salesRows(input: CyberbizReportIngestInput) {
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
  for (const value of input.rows ?? []) {
    if (!record(value)) throw new CyberbizReportIngestError(422, "invalid_ingest");
    if (value.businessDate !== undefined) throw new CyberbizReportIngestError(422, "invalid_ingest");
    const reportMonth = month(value.reportMonth ?? input.reportMonth);
    if (input.reportMonth && reportMonth !== input.reportMonth) {
      throw new CyberbizReportIngestError(422, "invalid_ingest");
    }
    const sku = text(value.sku);
    const key = `${reportMonth}\u0000${sku}`;
    const previous = rows.get(key);
    rows.set(key, {
      scopeId: input.scopeId,
      reportMonth,
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
        await insertReportSalesMonthly(db, sales, input.reportMonth
          ? { scopeId: scope.id, reportMonth: input.reportMonth }
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
