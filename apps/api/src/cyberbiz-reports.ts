import {
  queryReportPayoutSummary,
  queryReportSalesSummary,
  parseReportRange,
  queryReportPayout,
  queryReportSales,
  ReportScopeAmbiguousError,
  type CyberbizPayoutQuery,
  type CyberbizSalesQuery,
  type Database,
  type ReportGroupBy,
  type ReportPayoutQueryResult,
  type ReportPayoutSummary,
  type ReportRange,
  type ReportSalesSummary,
  type ReportSalesQueryResult,
  type ReportScopeKind,
} from "@rueisiang/db";

export class CyberbizReportQueryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CyberbizReportQueryError";
    this.status = status;
    this.code = code;
  }
}

function rangeOf(input: { period?: string; reportMonth?: string; startDate?: string; endDate?: string }): ReportRange {
  try {
    return parseReportRange(input.period ?? input.reportMonth, input.startDate, input.endDate);
  } catch (error) {
    throw new CyberbizReportQueryError(400, "invalid_report_range", error instanceof Error ? error.message : "報表日期區間不正確。");
  }
}

function groupByOf(value: readonly ReportGroupBy[] | undefined, kind: "sales" | "payout"): ReportGroupBy[] | undefined {
  if (!value) return undefined;
  const allowed = kind === "payout"
    ? new Set<ReportGroupBy>(["day", "month", "scope"])
    : new Set<ReportGroupBy>(["month", "scope", "sku", "category"]);
  if (value.some((item) => !allowed.has(item))) {
    throw new CyberbizReportQueryError(
      400,
      "invalid_group_by",
      kind === "payout" ? "出金報表的 groupBy 只能使用 day、month 或 scope。" : "商品銷售報表的 groupBy 只能使用 month、scope、sku 或 category。",
    );
  }
  return [...new Set(value)];
}

function translateScopeError(error: unknown): never {
  if (error instanceof ReportScopeAmbiguousError) {
    throw new CyberbizReportQueryError(409, "ambiguous_scope", error.message);
  }
  throw error;
}

function noSalesData(range: ReportRange, scopeType: ReportScopeKind): ReportSalesQueryResult {
  return {
    status: "NO_DATA_FOR_RANGE",
    period: range.period,
    requestedStart: range.startDate,
    requestedEnd: range.endDate,
    scopeType,
    rows: [],
    totals: { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 },
    message: "指定區間沒有已匯入的商品銷售資料。請到後台執行商品銷售報表下載作業。",
  };
}

function noPayoutData(range: ReportRange, scopeType: ReportScopeKind): ReportPayoutQueryResult {
  return {
    status: "NO_DATA_FOR_RANGE",
    period: range.period,
    requestedStart: range.startDate,
    requestedEnd: range.endDate,
    scopeType,
    rows: [],
    totals: { payoutAmount: 0 },
    message: "指定區間沒有已匯入的出金資料。請到後台執行出金表下載作業。",
  };
}

export function createCyberbizReportService(db: Database) {
  return {
    async querySales(input: CyberbizSalesQuery): Promise<ReportSalesQueryResult> {
      if (input.scopeType !== "company" && !input.scopeId && !input.scopeName) {
        throw new CyberbizReportQueryError(400, "missing_scope_name", input.scopeType === "channel" ? "查詢單一通路時需要通路名稱。" : "查詢單一櫃位時需要店面名稱。");
      }
      const range = rangeOf(input);
      const groups = groupByOf(input.groupBy, "sales");
      try {
        const result = await queryReportSales(db, {
          range,
          scopeType: input.scopeType,
          ...(input.scopeId ? { scopeId: input.scopeId } : {}),
          ...(input.scopeName ? { scopeName: input.scopeName } : {}),
          ...(groups ? { groupBy: groups } : {}),
          ...(input.itemIds ? { itemIds: input.itemIds } : {}),
          ...(input.sku ? { sku: input.sku } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.productName ? { productName: input.productName } : {}),
          ...(input.productQuery ? { productQuery: input.productQuery } : {}),
        });
        return result ?? noSalesData(range, input.scopeType);
      } catch (error) {
        return translateScopeError(error);
      }
    },
    async queryPayout(input: CyberbizPayoutQuery): Promise<ReportPayoutQueryResult> {
      if (input.scopeType !== "company" && !input.scopeId && !input.scopeName) {
        throw new CyberbizReportQueryError(400, "missing_scope_name", input.scopeType === "channel" ? "查詢單一通路時需要通路名稱。" : "查詢單一櫃位時需要店面名稱。");
      }
      const range = rangeOf(input);
      const groups = groupByOf(input.groupBy, "payout");
      try {
        const result = await queryReportPayout(db, {
          range,
          scopeType: input.scopeType,
          ...(input.scopeId ? { scopeId: input.scopeId } : {}),
          ...(input.scopeName ? { scopeName: input.scopeName } : {}),
          ...(groups ? { groupBy: groups } : {}),
        });
        return result ?? noPayoutData(range, input.scopeType);
      } catch (error) {
        return translateScopeError(error);
      }
    },
    async queryPayoutSummary(input: CyberbizPayoutQuery): Promise<ReportPayoutSummary> {
      if (input.scopeType !== "company" && !input.scopeId && !input.scopeName) {
        throw new CyberbizReportQueryError(400, "missing_scope_name", input.scopeType === "channel" ? "查詢單一通路時需要通路名稱。" : "查詢單一櫃位時需要店面名稱。");
      }
      const range = rangeOf(input);
      try {
        return await queryReportPayoutSummary(db, {
          range,
          scopeType: input.scopeType,
          ...(input.scopeId ? { scopeId: input.scopeId } : {}),
          ...(input.scopeName ? { scopeName: input.scopeName } : {}),
        });
      } catch (error) {
        return translateScopeError(error);
      }
    },
    async querySalesSummary(input: CyberbizSalesQuery): Promise<ReportSalesSummary> {
      if (input.scopeType !== "company" && !input.scopeId && !input.scopeName) {
        throw new CyberbizReportQueryError(400, "missing_scope_name", input.scopeType === "channel" ? "查詢單一通路時需要通路名稱。" : "查詢單一櫃位時需要店面名稱。");
      }
      const range = rangeOf(input);
      try {
        return await queryReportSalesSummary(db, {
          range,
          scopeType: input.scopeType,
          ...(input.scopeId ? { scopeId: input.scopeId } : {}),
          ...(input.scopeName ? { scopeName: input.scopeName } : {}),
          ...(input.productQuery ? { productQuery: input.productQuery } : {}),
          ...(input.topSkuBy ? { topSkuBy: input.topSkuBy } : {}),
        });
      } catch (error) {
        return translateScopeError(error);
      }
    },
  };
}
