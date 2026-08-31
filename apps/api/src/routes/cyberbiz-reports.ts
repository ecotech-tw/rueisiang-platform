import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createReportManualPayout,
  createReportManualSales,
  createReportManagementScope,
  deleteReportPayoutDaily,
  deleteReportManualPayout,
  deleteReportManualSales,
  deleteReportPayoutRecord,
  deleteReportSalesRecord,
  insertReportPayoutDaily,
  isCompanyReportStoreScopeId,
  isValidReportDate,
  latestReportSalesPeriods,
  listCyberbizReportProducts,
  listReportPayoutRecords,
  listReportManagementScopes,
  listReportSalesRecords,
  listReportScopes,
  ReportManualError,
  updateReportManualPayout,
  updateReportManualSales,
  updateReportManagementScope,
  updateReportPayoutDaily,
  normalizeExternalSku,
  upsertReportScope,
  type Database,
  type ReportGroupBy,
  type ReportManualRecordSource,
  type ReportManualSkuSource,
  type ReportPayoutListQuery,
  type ReportScopeKind,
  type ReportSalesListQuery,
} from "@rueisiang/db";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { createCyberbizReportService, CyberbizReportQueryError } from "../cyberbiz-reports.js";
import { createCyberbizReportIngestor, CyberbizReportIngestError } from "../cyberbiz-report-ingest.js";
import { manualScopeIdFromStoreName } from "../cyberbiz-scope.js";
import { cachedReportAnalytics, forgetReportAnalytics } from "../report-cache.js";
import { cacheClient } from "../upstash.js";
import { body, requireString } from "../request.js";

function queryValue(c: { req: { query(name: string): string | undefined } }, name: string): string | undefined {
  const value = c.req.query(name)?.trim();
  return value || undefined;
}

function groupBy(c: { req: { query(name: string): string | undefined } }): ReportGroupBy[] | undefined {
  const value = queryValue(c, "groupBy");
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()) as ReportGroupBy[];
}

function analyticsCacheKey(c: { req: { url: string } }, resource: string): string {
  const url = new URL(c.req.url);
  const entries = [...url.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) => (
    leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
  ));
  const query = entries.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  return query ? `${resource}?${query}` : resource;
}

function topSkuBy(c: { req: { query(name: string): string | undefined } }): "salesAmount" | "netQuantity" | undefined {
  const value = queryValue(c, "topSkuBy");
  if (!value) return undefined;
  if (value !== "salesAmount" && value !== "netQuantity") {
    throw new HTTPException(400, { message: "topSkuBy 必須是 salesAmount 或 netQuantity。" });
  }
  return value;
}

function commonQuery(c: { req: { query(name: string): string | undefined } }) {
  const scopeType = queryValue(c, "scopeType") ?? "company";
  if (scopeType !== "company" && scopeType !== "store") {
    throw new HTTPException(400, { message: "scopeType 必須是 company 或 store。" });
  }
  const scopeId = queryValue(c, "scopeId");
  const scopeName = queryValue(c, "scopeName");
  const groups = groupBy(c);
  if (scopeType === "store" && !scopeId && !scopeName) throw new HTTPException(400, { message: "查詢單一櫃位時需要店面名稱。" });
  return {
    period: queryValue(c, "period"),
    startDate: queryValue(c, "startDate"),
    endDate: queryValue(c, "endDate"),
    scopeType: scopeType as ReportScopeKind,
    ...(scopeId ? { scopeId } : {}),
    ...(scopeName ? { scopeName } : {}),
    ...(queryValue(c, "product") ? { productQuery: queryValue(c, "product") } : {}),
    ...(groups ? { groupBy: groups } : {}),
  };
}

function handleError(error: unknown): never {
  if (error instanceof CyberbizReportQueryError) {
    throw new HTTPException(error.status as 400 | 404 | 409 | 422 | 502 | 503, { message: error.message });
  }
  throw error;
}

function handleManualError(error: unknown): never {
  if (error instanceof ReportManualError) {
    const status = error.kind === "not_found" ? 404 : error.kind === "conflict" ? 409 : 400;
    throw new HTTPException(status, { message: error.message });
  }
  throw error;
}

function manualId(c: { req: { param(name: string): string | undefined } }): string {
  const id = c.req.param("id")?.trim();
  if (!id) throw new HTTPException(400, { message: "缺少人工修訂資料 ID。" });
  return id;
}

const MANUAL_REPORT_PAGE_SIZES = [10, 25, 50, 100] as const;

function listPage(c: { req: { query(name: string): string | undefined } }): number {
  const value = Number(queryValue(c, "page"));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function listPageSize(c: { req: { query(name: string): string | undefined } }): number {
  const value = Number(queryValue(c, "pageSize"));
  return (MANUAL_REPORT_PAGE_SIZES as readonly number[]).includes(value) ? value : 25;
}

function listSource(c: { req: { query(name: string): string | undefined } }): ReportManualRecordSource | undefined {
  const value = queryValue(c, "source");
  if (!value || value === "all") return undefined;
  if (value !== "imported" && value !== "manual") {
    throw new HTTPException(400, { message: "資料來源必須是 imported、manual 或 all。" });
  }
  return value;
}

function listDirection(c: { req: { query(name: string): string | undefined } }): "asc" | "desc" {
  return queryValue(c, "sortDirection") === "asc" ? "asc" : "desc";
}

function listDate(c: { req: { query(name: string): string | undefined } }, name: string): string | undefined {
  const value = queryValue(c, name);
  if (value && !isValidReportDate(value)) {
    throw new HTTPException(400, { message: `${name} 必須是有效的 YYYY-MM-DD。` });
  }
  return value;
}

function listMonth(c: { req: { query(name: string): string | undefined } }, name: string): string | undefined {
  const value = queryValue(c, name);
  if (value && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new HTTPException(400, { message: `${name} 必須是有效的 YYYY-MM。` });
  }
  return value;
}

function manualPayoutListQuery(c: { req: { query(name: string): string | undefined } }): ReportPayoutListQuery {
  const startDate = listDate(c, "startDate");
  const endDate = listDate(c, "endDate");
  if (startDate && endDate && startDate > endDate) {
    throw new HTTPException(400, { message: "出金日期起日不可晚於迄日。" });
  }
  const rawSortField = queryValue(c, "sortField");
  const sortField = ["scope", "businessDate", "payoutAmount", "updatedAt"].includes(rawSortField ?? "")
    ? rawSortField as ReportPayoutListQuery["sortField"]
    : "businessDate";
  const scopeId = queryValue(c, "scopeId");
  const search = queryValue(c, "search");
  const source = listSource(c);
  return {
    page: listPage(c),
    pageSize: listPageSize(c),
    ...(scopeId ? { scopeId } : {}),
    ...(source ? { source } : {}),
    ...(search ? { search } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    sortField,
    sortDirection: listDirection(c),
  };
}

function manualSalesListQuery(c: { req: { query(name: string): string | undefined } }): ReportSalesListQuery {
  const startMonth = listMonth(c, "startMonth");
  const endMonth = listMonth(c, "endMonth");
  if (startMonth && endMonth && startMonth > endMonth) {
    throw new HTTPException(400, { message: "商品銷售月份起月不可晚於迄月。" });
  }
  const rawSortField = queryValue(c, "sortField");
  const sortField = ["scope", "reportMonth", "sku", "productName", "netQuantity", "salesAmount", "updatedAt"].includes(rawSortField ?? "")
    ? rawSortField as ReportSalesListQuery["sortField"]
    : "reportMonth";
  const scopeId = queryValue(c, "scopeId");
  const search = queryValue(c, "search");
  const source = listSource(c);
  return {
    page: listPage(c),
    pageSize: listPageSize(c),
    ...(scopeId ? { scopeId } : {}),
    ...(source ? { source } : {}),
    ...(search ? { search } : {}),
    ...(startMonth ? { startMonth } : {}),
    ...(endMonth ? { endMonth } : {}),
    sortField,
    sortDirection: listDirection(c),
  };
}

function safeIntegerInput(input: Record<string, unknown>, field: string, label: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HTTPException(400, { message: `${label}必須是安全整數。` });
  }
  return value;
}

function manualPayoutInput(input: Record<string, unknown>) {
  return {
    scopeId: requireString(input, "scopeId", "據點"),
    businessDate: requireString(input, "businessDate", "出金日期"),
    payoutAmount: safeIntegerInput(input, "payoutAmount", "出金金額"),
  };
}

function manualSalesInput(input: Record<string, unknown>): {
  scopeId: string;
  reportMonth: string;
  skuSource: ReportManualSkuSource;
  sku: string;
  productName?: string;
  category?: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
} {
  const skuSource = requireString(input, "skuSource", "SKU 來源");
  if (skuSource !== "custom" && skuSource !== "cyberbiz") {
    throw new HTTPException(400, { message: "SKU 來源必須是 custom 或 cyberbiz。" });
  }
  return {
    scopeId: requireString(input, "scopeId", "據點"),
    reportMonth: requireString(input, "reportMonth", "報表月份"),
    skuSource,
    sku: requireString(input, "sku", "SKU"),
    ...(typeof input.productName === "string" ? { productName: input.productName } : {}),
    ...(typeof input.category === "string" ? { category: input.category } : {}),
    grossQuantity: safeIntegerInput(input, "grossQuantity", "銷售數量"),
    returnQuantity: safeIntegerInput(input, "returnQuantity", "退貨數量"),
    netQuantity: safeIntegerInput(input, "netQuantity", "淨銷售數量"),
    salesAmount: safeIntegerInput(input, "salesAmount", "銷售金額"),
  };
}

function importScope(input: Record<string, unknown>): { scopeId: string; scopeName: string } {
  const scopeName = requireString(input, "scopeName", "據點名稱");
  const requestedScopeId = typeof input.scopeId === "string" ? input.scopeId.trim() : "";
  if (requestedScopeId && !isCompanyReportStoreScopeId(requestedScopeId)) {
    throw new HTTPException(400, { message: "據點 ID 不是公司報表可辨識的店別。" });
  }
  return {
    scopeId: requestedScopeId || manualScopeIdFromStoreName(scopeName),
    scopeName,
  };
}

function safeImportTotal(current: number, next: number, label: string): number {
  const total = current + next;
  if (!Number.isSafeInteger(total)) {
    throw new HTTPException(400, { message: `${label}加總超出可安全儲存的整數範圍。` });
  }
  return total;
}

function importPayoutInput(input: Record<string, unknown>): {
  scopeId: string;
  scopeName: string;
  rows: Array<{ scopeId: string; businessDate: string; payoutAmount: number }>;
} {
  const scope = importScope(input);
  if (!Array.isArray(input.rows) || !input.rows.length) {
    throw new HTTPException(400, { message: "沒有可匯入的出金資料。" });
  }
  const amounts = new Map<string, number>();
  for (const value of input.rows) {
    if (!isRecord(value)) throw new HTTPException(400, { message: "出金資料格式不正確。" });
    const businessDate = requireString(value, "businessDate", "出金日期");
    if (!isValidReportDate(businessDate)) {
      throw new HTTPException(400, { message: `出金日期格式不正確：${businessDate}` });
    }
    const amount = safeIntegerInput(value, "payoutAmount", "出金金額");
    amounts.set(businessDate, safeImportTotal(amounts.get(businessDate) ?? 0, amount, `${businessDate} 的金額`));
  }
  return {
    ...scope,
    rows: [...amounts].map(([businessDate, payoutAmount]) => ({ scopeId: scope.scopeId, businessDate, payoutAmount })),
  };
}

interface ImportedSalesRow {
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
}

function importSalesInput(input: Record<string, unknown>): {
  scopeId: string;
  scopeName: string;
  reportMonth: string;
  rows: ImportedSalesRow[];
} {
  const scope = importScope(input);
  const reportMonth = requireString(input, "reportMonth", "報表月份");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth)) {
    throw new HTTPException(400, { message: "報表月份必須是有效的 YYYY-MM。" });
  }
  if (!Array.isArray(input.rows) || !input.rows.length) {
    throw new HTTPException(400, { message: "沒有可匯入的商品銷售資料。" });
  }

  const rows = new Map<string, ImportedSalesRow>();
  for (const value of input.rows) {
    if (!isRecord(value)) throw new HTTPException(400, { message: "商品銷售資料格式不正確。" });
    const sku = normalizeExternalSku(requireString(value, "sku", "SKU"));
    const previous = rows.get(sku);
    const productName = typeof value.productName === "string" && value.productName.trim()
      ? value.productName.trim()
      : previous?.productName ?? sku;
    const category = typeof value.category === "string" && value.category.trim()
      ? value.category.trim()
      : previous?.category ?? "未分類";
    const next = {
      scopeId: scope.scopeId,
      reportMonth,
      sku,
      productName,
      category,
      grossQuantity: safeIntegerInput(value, "grossQuantity", "銷售數量"),
      returnQuantity: safeIntegerInput(value, "returnQuantity", "退回數量"),
      netQuantity: safeIntegerInput(value, "netQuantity", "淨銷售數量"),
      salesAmount: safeIntegerInput(value, "salesAmount", "銷售金額"),
      updatedAt: new Date().toISOString(),
    };
    rows.set(sku, previous ? {
      ...next,
      productName: previous.productName || next.productName,
      category: previous.category || next.category,
      grossQuantity: safeImportTotal(previous.grossQuantity, next.grossQuantity, `${sku} 的銷售數量`),
      returnQuantity: safeImportTotal(previous.returnQuantity, next.returnQuantity, `${sku} 的退回數量`),
      netQuantity: safeImportTotal(previous.netQuantity, next.netQuantity, `${sku} 的淨銷售數量`),
      salesAmount: safeImportTotal(previous.salesAmount, next.salesAmount, `${sku} 的銷售金額`),
    } : next);
  }
  return { ...scope, reportMonth, rows: [...rows.values()] };
}

function recordDeleteSource(input: Record<string, unknown>): ReportManualRecordSource {
  if (input.source !== "imported" && input.source !== "manual") {
    throw new HTTPException(400, { message: "紀錄來源格式不正確。" });
  }
  return input.source;
}

function reportScopeId(c: { req: { param(name: string): string | undefined } }): string {
  const id = c.req.param("id")?.trim();
  if (!id) throw new HTTPException(400, { message: "缺少據點 ID。" });
  return id;
}

function reportScopeName(input: Record<string, unknown>): string {
  return requireString(input, "name", "據點名稱");
}

function reportScopeActive(input: Record<string, unknown>): boolean | undefined {
  if (input.active === undefined) return undefined;
  if (typeof input.active !== "boolean") throw new HTTPException(400, { message: "據點啟用狀態格式不正確。" });
  return input.active;
}

async function payoutRecordDeleteInput(c: { req: { json(): Promise<unknown> } }): Promise<{
  source: ReportManualRecordSource;
  id: string;
  scopeId: string;
  businessDate: string;
}> {
  const input = await body(c);
  const businessDate = requireString(input, "businessDate", "出金日期");
  if (!isValidReportDate(businessDate)) throw new HTTPException(400, { message: "出金日期必須是有效的 YYYY-MM-DD。" });
  return {
    source: recordDeleteSource(input),
    id: requireString(input, "id", "紀錄 ID"),
    scopeId: requireString(input, "scopeId", "據點"),
    businessDate,
  };
}

async function salesRecordDeleteInput(c: { req: { json(): Promise<unknown> } }): Promise<{
  source: ReportManualRecordSource;
  id: string;
  scopeId: string;
  reportMonth: string;
  sku: string;
}> {
  const input = await body(c);
  const reportMonth = requireString(input, "reportMonth", "報表月份");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth)) throw new HTTPException(400, { message: "報表月份必須是有效的 YYYY-MM。" });
  return {
    source: recordDeleteSource(input),
    id: requireString(input, "id", "紀錄 ID"),
    scopeId: requireString(input, "scopeId", "據點"),
    reportMonth,
    sku: requireString(input, "sku", "SKU"),
  };
}

function payoutTarget(c: { req: { param(name: string): string | undefined } }): { scopeId: string; businessDate: string } {
  const scopeId = c.req.param("scopeId")?.trim();
  const businessDate = c.req.param("businessDate")?.trim();
  if (!scopeId || !businessDate || !isValidReportDate(businessDate)) {
    throw new HTTPException(400, { message: "日期格式必須是 YYYY-MM-DD。" });
  }
  return { scopeId, businessDate };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPayoutAmount(c: { req: { json(): Promise<unknown> } }): Promise<number> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "請提供有效的 JSON 出金金額。" });
  }
  if (!isRecord(body) || !Number.isSafeInteger(body.payoutAmount)) {
    throw new HTTPException(400, { message: "出金金額必須是安全整數。" });
  }
  return body.payoutAmount as number;
}

async function updatePayout(
  db: Database,
  target: { scopeId: string; businessDate: string },
  payoutAmount: number,
) {
  const row = await updateReportPayoutDaily(db, { ...target, payoutAmount });
  if (!row) throw new HTTPException(404, { message: "找不到指定日期的出金資料。" });
  return row;
}

export const cyberbizReports = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/scopes", requirePermission("reports:analytics:read"), async (c) => {
    const result = await cachedReportAnalytics(cacheClient(c.env), "scopes", async () => {
      const scopes = await listReportScopes(c.get("db"), "store");
      const latest = await latestReportSalesPeriods(c.get("db"), scopes.map((scope) => scope.id));
      return {
        latestSalesPeriod: latest.latestPeriod,
        scopes: scopes.map((scope) => ({
          id: scope.id,
          name: scope.name,
          latestSalesPeriod: latest.byScope[scope.id] ?? null,
        })),
      };
    });
    return c.json(result);
  })
  .get("/manual/options", requirePermission("reports:cyberbiz:write"), async (c) => {
    const [scopes, products] = await Promise.all([
      listReportScopes(c.get("db"), "store"),
      listCyberbizReportProducts(c.get("db")),
    ]);
    return c.json({
      scopes: scopes
        .filter((scope) => scope.active === 1 && isCompanyReportStoreScopeId(scope.id))
        .map((scope) => ({ id: scope.id, name: scope.name })),
      products,
    });
  })
  .get("/manual/scopes", requirePermission("reports:cyberbiz:write"), async (c) => {
    return c.json({ scopes: await listReportManagementScopes(c.get("db")) });
  })
  .post("/manual/scopes", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = await body(c);
      const name = reportScopeName(input);
      const scope = await createReportManagementScope(c.get("db"), {
        id: manualScopeIdFromStoreName(name),
        name,
        active: reportScopeActive(input),
      });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ scope }, 201);
    } catch (error) {
      handleManualError(error);
    }
  })
  .patch("/manual/scopes/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = await body(c);
      const name = input.name === undefined ? undefined : reportScopeName(input);
      const active = reportScopeActive(input);
      const scope = await updateReportManagementScope(c.get("db"), {
        id: reportScopeId(c),
        ...(name === undefined ? {} : { name }),
        ...(active === undefined ? {} : { active }),
      });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ scope });
    } catch (error) {
      handleManualError(error);
    }
  })
  .delete("/manual/scopes/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const scope = await updateReportManagementScope(c.get("db"), { id: reportScopeId(c), active: false });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ scope });
    } catch (error) {
      handleManualError(error);
    }
  })
  .post("/manual/import/payout", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = importPayoutInput(await body(c));
      const scope = await upsertReportScope(c.get("db"), { id: input.scopeId, scopeKind: "store", name: input.scopeName });
      await insertReportPayoutDaily(c.get("db"), input.rows);
      await forgetReportAnalytics(cacheClient(c.env));
      const dates = input.rows.map((row) => row.businessDate).sort();
      return c.json({
        scopeId: scope.id,
        scopeName: scope.name,
        dayCount: input.rows.length,
        total: input.rows.reduce((sum, row) => safeImportTotal(sum, row.payoutAmount, "出金金額"), 0),
        coverageStart: dates[0],
        coverageEnd: dates[dates.length - 1],
      }, 201);
    } catch (error) {
      handleManualError(error);
    }
  })
  .post("/manual/import/sales", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = importSalesInput(await body(c));
      const scope = await upsertReportScope(c.get("db"), { id: input.scopeId, scopeKind: "store", name: input.scopeName });
      let result;
      try {
        result = await createCyberbizReportIngestor(c.get("db")).ingest({
          kind: "sales",
          scopeType: "store",
          scopeId: scope.id,
          scopeName: scope.name,
          reportMonth: input.reportMonth,
          rows: input.rows,
        });
      } catch (error) {
        if (error instanceof CyberbizReportIngestError) {
          throw new HTTPException(error.status, { message: error.message });
        }
        throw error;
      }
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({
        scopeId: scope.id,
        scopeName: scope.name,
        reportMonth: input.reportMonth,
        rowCount: result.rowCount,
        skippedSkus: result.skippedSkus ?? [],
        totals: result.salesTotals ?? {
          grossQuantity: 0,
          returnQuantity: 0,
          netQuantity: 0,
          salesAmount: 0,
        },
      }, 201);
    } catch (error) {
      handleManualError(error);
    }
  })
  .get("/manual/payout", requirePermission("reports:cyberbiz:write"), async (c) => {
    return c.json(await listReportPayoutRecords(c.get("db"), manualPayoutListQuery(c)));
  })
  .post("/manual/payout", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = manualPayoutInput(await body(c));
      const user = c.get("user");
      const row = await createReportManualPayout(c.get("db"), { ...input, actor: { id: user.id, email: user.email } });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ row: { ...row, source: "manual" as const } }, 201);
    } catch (error) {
      handleManualError(error);
    }
  })
  .patch("/manual/payout/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = manualPayoutInput(await body(c));
      const user = c.get("user");
      const row = await updateReportManualPayout(c.get("db"), { id: manualId(c), ...input, actor: { id: user.id, email: user.email } });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ row: { ...row, source: "manual" as const } });
    } catch (error) {
      handleManualError(error);
    }
  })
  .delete("/manual/payout/record", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const user = c.get("user");
      await deleteReportPayoutRecord(c.get("db"), await payoutRecordDeleteInput(c), { id: user.id, email: user.email });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ ok: true });
    } catch (error) {
      handleManualError(error);
    }
  })
  .delete("/manual/payout/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const user = c.get("user");
      await deleteReportManualPayout(c.get("db"), manualId(c), { id: user.id, email: user.email });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ ok: true });
    } catch (error) {
      handleManualError(error);
    }
  })
  .get("/manual/sales", requirePermission("reports:cyberbiz:write"), async (c) => {
    return c.json(await listReportSalesRecords(c.get("db"), manualSalesListQuery(c)));
  })
  .post("/manual/sales", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = manualSalesInput(await body(c));
      const user = c.get("user");
      const row = await createReportManualSales(c.get("db"), { ...input, actor: { id: user.id, email: user.email } });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ row: { ...row, source: "manual" as const } }, 201);
    } catch (error) {
      handleManualError(error);
    }
  })
  .patch("/manual/sales/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const input = manualSalesInput(await body(c));
      const user = c.get("user");
      const row = await updateReportManualSales(c.get("db"), { id: manualId(c), ...input, actor: { id: user.id, email: user.email } });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ row: { ...row, source: "manual" as const } });
    } catch (error) {
      handleManualError(error);
    }
  })
  .delete("/manual/sales/record", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const user = c.get("user");
      await deleteReportSalesRecord(c.get("db"), await salesRecordDeleteInput(c), { id: user.id, email: user.email });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ ok: true });
    } catch (error) {
      handleManualError(error);
    }
  })
  .delete("/manual/sales/:id", requirePermission("reports:cyberbiz:write"), async (c) => {
    try {
      const user = c.get("user");
      await deleteReportManualSales(c.get("db"), manualId(c), { id: user.id, email: user.email });
      await forgetReportAnalytics(cacheClient(c.env));
      return c.json({ ok: true });
    } catch (error) {
      handleManualError(error);
    }
  })
  .get("/summary/payout", requirePermission("reports:analytics:read"), async (c) => {
    try {
      const query = commonQuery(c);
      const result = await cachedReportAnalytics(
        cacheClient(c.env),
        analyticsCacheKey(c, "summary:payout"),
        () => createCyberbizReportService(c.get("db")).queryPayoutSummary(query),
      );
      return c.json(result);
    } catch (error) {
      handleError(error);
    }
  })
  .get("/summary/payout/daily", requirePermission("reports:analytics:read"), async (c) => {
    try {
      return c.json(await createCyberbizReportService(c.get("db")).queryPayout({
        ...commonQuery(c),
        groupBy: ["day"],
      }));
    } catch (error) {
      handleError(error);
    }
  })
  .get("/summary/sales", requirePermission("reports:analytics:read"), async (c) => {
    try {
      const selectedTopSkuBy = topSkuBy(c);
      const query = {
        ...commonQuery(c),
        ...(selectedTopSkuBy ? { topSkuBy: selectedTopSkuBy } : {}),
      };
      const result = await cachedReportAnalytics(
        cacheClient(c.env),
        analyticsCacheKey(c, "summary:sales:v2"),
        () => createCyberbizReportService(c.get("db")).querySalesSummary(query),
      );
      return c.json(result);
    } catch (error) {
      handleError(error);
    }
  })
  .get("/sales", requirePermission("reports:cyberbiz:read"), async (c) => {
    try {
      const query = {
        ...commonQuery(c),
        ...(queryValue(c, "sku") ? { sku: queryValue(c, "sku") } : {}),
        ...(queryValue(c, "category") ? { category: queryValue(c, "category") } : {}),
        ...(queryValue(c, "productName") ? { productName: queryValue(c, "productName") } : {}),
      };
      const result = await cachedReportAnalytics(
        cacheClient(c.env),
        analyticsCacheKey(c, "sales"),
        () => createCyberbizReportService(c.get("db")).querySales(query),
      );
      return c.json(result);
    } catch (error) {
      handleError(error);
    }
  })
  .get("/payout", requirePermission("reports:cyberbiz:read"), async (c) => {
    try {
      const query = commonQuery(c);
      const result = await cachedReportAnalytics(
        cacheClient(c.env),
        analyticsCacheKey(c, "payout"),
        () => createCyberbizReportService(c.get("db")).queryPayout(query),
      );
      return c.json(result);
    } catch (error) {
      handleError(error);
    }
  })
  .patch("/payout/:scopeId/:businessDate", requirePermission("reports:cyberbiz:write"), async (c) => {
    const target = payoutTarget(c);
    const payoutAmount = await readPayoutAmount(c);
    return c.json({ row: await updatePayout(c.get("db"), target, payoutAmount) });
  })
  .delete("/payout/:scopeId/:businessDate", requirePermission("reports:cyberbiz:write"), async (c) => {
    const target = payoutTarget(c);
    if (!(await deleteReportPayoutDaily(c.get("db"), target))) {
      throw new HTTPException(404, { message: "找不到指定日期的出金資料。" });
    }
    return c.json({ ok: true });
  });
