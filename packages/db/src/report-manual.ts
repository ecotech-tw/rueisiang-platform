import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { isCompanyReportStoreScopeId, isValidReportDate, normalizeReportScopeName } from "./report-data.js";
import { activityEvents } from "./schema/activity.js";
import {
  reportManualPayoutDaily,
  reportManualSalesMonthly,
  reportPayoutDaily,
  reportSalesMonthly,
  reportScopes,
  type ReportManualPayoutDaily,
  type ReportManualSalesMonthly,
  type ReportManualSkuSource,
} from "./schema/reports.js";
import { cyberbizProducts } from "./schema/wms.js";
import { normalizeExternalSku } from "./product-sku-mappings.js";

export interface ReportManualActor {
  id: string;
  email: string;
}

export type ReportManualErrorKind = "invalid" | "not_found" | "conflict";

export class ReportManualError extends Error {
  constructor(
    readonly kind: ReportManualErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ReportManualError";
  }
}

export interface ReportManualPayoutInput {
  scopeId: string;
  businessDate: string;
  payoutAmount: number;
  actor: ReportManualActor;
}

export interface ReportManualSalesInput {
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
  actor: ReportManualActor;
}

export type ReportManualPayoutRow = ReportManualPayoutDaily & { scopeName: string };
export type ReportManualSalesRow = ReportManualSalesMonthly & { scopeName: string };
export type ReportManualRecordSource = "imported" | "manual";

export interface ReportPayoutListQuery {
  page: number;
  pageSize: number;
  scopeId?: string;
  source?: ReportManualRecordSource;
  search?: string;
  startDate?: string;
  endDate?: string;
  sortField: "scope" | "businessDate" | "payoutAmount" | "updatedAt";
  sortDirection: "asc" | "desc";
}

export interface ReportSalesListQuery {
  page: number;
  pageSize: number;
  scopeId?: string;
  source?: ReportManualRecordSource;
  search?: string;
  startMonth?: string;
  endMonth?: string;
  sortField: "scope" | "reportMonth" | "sku" | "productName" | "netQuantity" | "salesAmount" | "updatedAt";
  sortDirection: "asc" | "desc";
}

export interface ReportPayoutRecord {
  id: string;
  source: ReportManualRecordSource;
  scopeId: string;
  scopeName: string;
  businessDate: string;
  payoutAmount: number;
  updatedByEmail: string;
  updatedAt: string;
}

export interface ReportSalesRecord {
  id: string;
  source: ReportManualRecordSource;
  scopeId: string;
  scopeName: string;
  reportMonth: string;
  skuSource: ReportManualSkuSource | null;
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  updatedByEmail: string;
  updatedAt: string;
}

export interface ReportPayoutListResult {
  rows: ReportPayoutRecord[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ReportSalesListResult {
  rows: ReportSalesRecord[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ReportPayoutRecordDeleteInput {
  source: ReportManualRecordSource;
  id: string;
  scopeId: string;
  businessDate: string;
}

export interface ReportSalesRecordDeleteInput {
  source: ReportManualRecordSource;
  id: string;
  scopeId: string;
  reportMonth: string;
  sku: string;
}

export interface ReportManagementScope {
  id: string;
  name: string;
  active: boolean;
}

export interface ReportManagementScopeInput {
  id: string;
  name: string;
  active?: boolean;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ReportManualError("invalid", `${label}必須是安全整數。`);
  return value;
}

async function requireScope(db: Database, scopeId: string) {
  const id = scopeId.trim();
  if (!id) throw new ReportManualError("invalid", "請選擇據點。");
  const [scope] = await db.select({ id: reportScopes.id, name: reportScopes.name })
    .from(reportScopes)
    .where(and(
      eq(reportScopes.id, id),
      eq(reportScopes.scopeKind, "store"),
      eq(reportScopes.active, 1),
    ))
    .limit(1);
  if (!scope || !isCompanyReportStoreScopeId(scope.id)) {
    throw new ReportManualError("not_found", "找不到可納入公司報表的啟用據點。");
  }
  return scope;
}

export async function listReportManagementScopes(db: Database): Promise<ReportManagementScope[]> {
  const scopes = await db.select({
    id: reportScopes.id,
    name: reportScopes.name,
    active: reportScopes.active,
  }).from(reportScopes)
    .where(eq(reportScopes.scopeKind, "store"))
    .orderBy(desc(reportScopes.active), asc(reportScopes.name));
  return scopes
    .filter((scope) => isCompanyReportStoreScopeId(scope.id))
    .map((scope) => ({ ...scope, active: scope.active === 1 }));
}

export async function createReportManagementScope(
  db: Database,
  input: ReportManagementScopeInput,
): Promise<ReportManagementScope> {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id || !isCompanyReportStoreScopeId(id) || !name) {
    throw new ReportManualError("invalid", "據點 ID 或名稱不正確。");
  }
  const [existingId] = await db.select({ id: reportScopes.id }).from(reportScopes).where(eq(reportScopes.id, id)).limit(1);
  if (existingId) throw new ReportManualError("conflict", "這個據點 ID 已經存在。");
  const [existingName] = await db.select({ id: reportScopes.id }).from(reportScopes).where(and(
    eq(reportScopes.scopeKind, "store"),
    eq(reportScopes.normalizedName, normalizeReportScopeName(name)),
  )).limit(1);
  if (existingName) throw new ReportManualError("conflict", "這個據點名稱已經存在。");

  const now = new Date().toISOString();
  await db.insert(reportScopes).values({
    id,
    scopeKind: "store",
    name,
    normalizedName: normalizeReportScopeName(name),
    active: input.active === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  });
  return { id, name, active: input.active !== false };
}

export async function updateReportManagementScope(
  db: Database,
  input: { id: string; name?: string; active?: boolean },
): Promise<ReportManagementScope> {
  const id = input.id.trim();
  if (!id || !isCompanyReportStoreScopeId(id)) throw new ReportManualError("invalid", "據點 ID 不正確。");
  const [existing] = await db.select({ id: reportScopes.id, name: reportScopes.name, active: reportScopes.active })
    .from(reportScopes)
    .where(and(eq(reportScopes.id, id), eq(reportScopes.scopeKind, "store")))
    .limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這個據點。");
  const name = input.name === undefined ? existing.name : input.name.trim();
  if (!name) throw new ReportManualError("invalid", "據點名稱不可為空白。");
  if (name !== existing.name) {
    const [duplicate] = await db.select({ id: reportScopes.id }).from(reportScopes).where(and(
      eq(reportScopes.scopeKind, "store"),
      eq(reportScopes.normalizedName, normalizeReportScopeName(name)),
      ne(reportScopes.id, id),
    )).limit(1);
    if (duplicate) throw new ReportManualError("conflict", "這個據點名稱已經存在。");
  }
  const active = input.active === undefined ? existing.active === 1 : input.active;
  await db.update(reportScopes).set({
    name,
    normalizedName: normalizeReportScopeName(name),
    active: active ? 1 : 0,
    updatedAt: new Date().toISOString(),
  }).where(eq(reportScopes.id, id));
  return { id, name, active };
}

async function preparePayout(
  db: Database,
  input: Omit<ReportManualPayoutInput, "actor">,
) {
  const scope = await requireScope(db, input.scopeId);
  const businessDate = input.businessDate.trim();
  if (!isValidReportDate(businessDate)) {
    throw new ReportManualError("invalid", "出金日期必須是有效的 YYYY-MM-DD。");
  }
  const payoutAmount = safeInteger(input.payoutAmount, "出金金額");
  return { scope, scopeId: scope.id, businessDate, payoutAmount };
}

async function prepareSales(
  db: Database,
  input: Omit<ReportManualSalesInput, "actor">,
) {
  const scope = await requireScope(db, input.scopeId);
  const reportMonth = input.reportMonth.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth)) {
    throw new ReportManualError("invalid", "商品銷售月份必須是有效的 YYYY-MM。");
  }
  if (input.skuSource !== "custom" && input.skuSource !== "cyberbiz") {
    throw new ReportManualError("invalid", "SKU 來源不正確。");
  }
  const sku = normalizeExternalSku(input.sku);
  if (!sku) throw new ReportManualError("invalid", "請填寫 SKU。");

  let productName = (input.productName ?? "").trim();
  let category = (input.category ?? "").trim() || "未分類";
  if (input.skuSource === "cyberbiz") {
    const [product] = await db.select({
      productName: cyberbizProducts.productName,
      variantName: cyberbizProducts.variantName,
    }).from(cyberbizProducts).where(eq(cyberbizProducts.sku, sku)).limit(1);
    if (!product) throw new ReportManualError("not_found", `找不到 CYBERBIZ SKU「${sku}」。`);
    productName = product.variantName ? `${product.productName}（${product.variantName}）` : product.productName;
    category = "未分類";
  } else if (!productName) {
    throw new ReportManualError("invalid", "自訂 SKU 必須填寫商品名稱。");
  }

  return {
    scope,
    scopeId: scope.id,
    reportMonth,
    skuSource: input.skuSource,
    sku,
    productName: productName || sku,
    category,
    grossQuantity: safeInteger(input.grossQuantity, "銷售數量"),
    returnQuantity: safeInteger(input.returnQuantity, "退貨數量"),
    netQuantity: safeInteger(input.netQuantity, "淨銷售數量"),
    salesAmount: safeInteger(input.salesAmount, "銷售金額"),
  };
}

function payoutLabel(scopeName: string, businessDate: string): string {
  return `出金 · ${scopeName} · ${businessDate}`;
}

function salesLabel(scopeName: string, reportMonth: string, sku: string): string {
  return `商品銷售 · ${scopeName} · ${reportMonth} · ${sku}`;
}

function payoutPayload(row: { scopeId: string; businessDate: string; payoutAmount: number }) {
  return {
    reportKind: "payout",
    scopeId: row.scopeId,
    businessDate: row.businessDate,
    payoutAmount: row.payoutAmount,
  };
}

function salesPayload(row: {
  scopeId: string;
  reportMonth: string;
  skuSource: ReportManualSkuSource;
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}) {
  return {
    reportKind: "sales",
    scopeId: row.scopeId,
    reportMonth: row.reportMonth,
    skuSource: row.skuSource,
    sku: row.sku,
    productName: row.productName,
    category: row.category,
    grossQuantity: row.grossQuantity,
    returnQuantity: row.returnQuantity,
    netQuantity: row.netQuantity,
    salesAmount: row.salesAmount,
  };
}

async function scopeNames(db: Database): Promise<Map<string, string>> {
  return new Map((await db.select({ id: reportScopes.id, name: reportScopes.name }).from(reportScopes))
    .map((scope) => [scope.id, scope.name]));
}

/*
 * 人工修訂頁讀的是「目前有效值」，不是只讀人工表：
 * - 同一 key 有人工資料時，排除匯入資料。
 * - 沒有人工資料時，保留匯入資料，讓它可以被編輯成人工覆寫。
 * - source/id 讓前端知道編輯時要建立覆寫，刪除時只能刪人工覆寫。
 */
const PAYOUT_RECORD_SOURCE = sql`(
  SELECT
    'imported' AS source,
    'imported:' || imported.scope_id || ':' || imported.business_date AS id,
    imported.scope_id,
    imported.business_date,
    imported.payout_amount,
    '系統匯入' AS updated_by_email,
    imported.updated_at
  FROM report_payout_daily AS imported
  WHERE NOT EXISTS (
    SELECT 1
    FROM report_manual_payout_daily AS manual
    WHERE manual.scope_id = imported.scope_id
      AND manual.business_date = imported.business_date
  )
  UNION ALL
  SELECT
    'manual' AS source,
    manual.id,
    manual.scope_id,
    manual.business_date,
    manual.payout_amount,
    manual.updated_by_email,
    manual.updated_at
  FROM report_manual_payout_daily AS manual
) AS report_payout_records`;

const SALES_RECORD_SOURCE = sql`(
  SELECT
    'imported' AS source,
    'imported:' || imported.scope_id || ':' || imported.report_month || ':' || imported.sku AS id,
    imported.scope_id,
    imported.report_month,
    NULL AS sku_source,
    imported.sku,
    imported.product_name,
    imported.category,
    imported.gross_quantity,
    imported.return_quantity,
    imported.net_quantity,
    imported.sales_amount,
    '系統匯入' AS updated_by_email,
    imported.updated_at
  FROM report_sales_monthly AS imported
  WHERE NOT EXISTS (
    SELECT 1
    FROM report_manual_sales_monthly AS manual
    WHERE manual.scope_id = imported.scope_id
      AND manual.report_month = imported.report_month
      AND lower(manual.sku) = lower(imported.sku)
  )
  UNION ALL
  SELECT
    'manual' AS source,
    manual.id,
    manual.scope_id,
    manual.report_month,
    manual.sku_source,
    manual.sku,
    manual.product_name,
    manual.category,
    manual.gross_quantity,
    manual.return_quantity,
    manual.net_quantity,
    manual.sales_amount,
    manual.updated_by_email,
    manual.updated_at
  FROM report_manual_sales_monthly AS manual
) AS report_sales_records`;

function textValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function listLimit(query: { page: number; pageSize: number }): { limit: number; offset: number } {
  return {
    limit: query.pageSize,
    offset: Math.max(0, query.page - 1) * query.pageSize,
  };
}

export async function listReportPayoutRecords(
  db: Database,
  query: ReportPayoutListQuery,
): Promise<ReportPayoutListResult> {
  const conditions = [sql`1 = 1`];
  if (query.scopeId) conditions.push(sql`report_payout_records.scope_id = ${query.scopeId}`);
  if (query.source) conditions.push(sql`report_payout_records.source = ${query.source}`);
  if (query.startDate) conditions.push(sql`report_payout_records.business_date >= ${query.startDate}`);
  if (query.endDate) conditions.push(sql`report_payout_records.business_date <= ${query.endDate}`);
  const search = query.search?.trim();
  if (search) {
    const term = `%${search}%`;
    conditions.push(sql`(
      lower(COALESCE(report_scopes.name, report_payout_records.scope_id)) LIKE lower(${term})
      OR report_payout_records.business_date LIKE ${term}
    )`);
  }
  const where = sql.join(conditions, sql` AND `);
  const from = sql`FROM ${PAYOUT_RECORD_SOURCE}
    LEFT JOIN report_scopes ON report_scopes.id = report_payout_records.scope_id`;
  const sortColumns = {
    scope: "COALESCE(report_scopes.name, report_payout_records.scope_id)",
    businessDate: "report_payout_records.business_date",
    payoutAmount: "report_payout_records.payout_amount",
    updatedAt: "report_payout_records.updated_at",
  } as const;
  const sortColumn = sortColumns[query.sortField] ?? sortColumns.businessDate;
  const direction = query.sortDirection === "asc" ? "ASC" : "DESC";
  const { limit, offset } = listLimit(query);
  const [countRows, rows] = await Promise.all([
    db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count ${from} WHERE ${where}`),
    db.all<Record<string, unknown>>(sql`SELECT
      report_payout_records.id AS id,
      report_payout_records.source AS source,
      report_payout_records.scope_id AS scopeId,
      COALESCE(report_scopes.name, report_payout_records.scope_id) AS scopeName,
      report_payout_records.business_date AS businessDate,
      report_payout_records.payout_amount AS payoutAmount,
      report_payout_records.updated_by_email AS updatedByEmail,
      report_payout_records.updated_at AS updatedAt
      ${from}
      WHERE ${where}
      ORDER BY ${sql.raw(sortColumn)} ${sql.raw(direction)}, report_payout_records.id ASC
      LIMIT ${limit} OFFSET ${offset}`),
  ]);
  return {
    rows: rows.map((row) => ({
      id: textValue(row.id),
      source: row.source === "manual" ? "manual" : "imported",
      scopeId: textValue(row.scopeId),
      scopeName: textValue(row.scopeName),
      businessDate: textValue(row.businessDate),
      payoutAmount: numberValue(row.payoutAmount),
      updatedByEmail: textValue(row.updatedByEmail) || "系統匯入",
      updatedAt: textValue(row.updatedAt),
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: numberValue(countRows[0]?.count),
  };
}

export async function listReportSalesRecords(
  db: Database,
  query: ReportSalesListQuery,
): Promise<ReportSalesListResult> {
  const conditions = [sql`1 = 1`];
  if (query.scopeId) conditions.push(sql`report_sales_records.scope_id = ${query.scopeId}`);
  if (query.source) conditions.push(sql`report_sales_records.source = ${query.source}`);
  if (query.startMonth) conditions.push(sql`report_sales_records.report_month >= ${query.startMonth}`);
  if (query.endMonth) conditions.push(sql`report_sales_records.report_month <= ${query.endMonth}`);
  const search = query.search?.trim();
  if (search) {
    const term = `%${search}%`;
    conditions.push(sql`(
      lower(COALESCE(report_scopes.name, report_sales_records.scope_id)) LIKE lower(${term})
      OR lower(report_sales_records.sku) LIKE lower(${term})
      OR lower(report_sales_records.product_name) LIKE lower(${term})
      OR lower(report_sales_records.category) LIKE lower(${term})
    )`);
  }
  const where = sql.join(conditions, sql` AND `);
  const from = sql`FROM ${SALES_RECORD_SOURCE}
    LEFT JOIN report_scopes ON report_scopes.id = report_sales_records.scope_id`;
  const sortColumns = {
    scope: "COALESCE(report_scopes.name, report_sales_records.scope_id)",
    reportMonth: "report_sales_records.report_month",
    sku: "report_sales_records.sku",
    productName: "report_sales_records.product_name",
    netQuantity: "report_sales_records.net_quantity",
    salesAmount: "report_sales_records.sales_amount",
    updatedAt: "report_sales_records.updated_at",
  } as const;
  const sortColumn = sortColumns[query.sortField] ?? sortColumns.reportMonth;
  const direction = query.sortDirection === "asc" ? "ASC" : "DESC";
  const { limit, offset } = listLimit(query);
  const [countRows, rows] = await Promise.all([
    db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count ${from} WHERE ${where}`),
    db.all<Record<string, unknown>>(sql`SELECT
      report_sales_records.id AS id,
      report_sales_records.source AS source,
      report_sales_records.scope_id AS scopeId,
      COALESCE(report_scopes.name, report_sales_records.scope_id) AS scopeName,
      report_sales_records.report_month AS reportMonth,
      report_sales_records.sku_source AS skuSource,
      report_sales_records.sku AS sku,
      report_sales_records.product_name AS productName,
      report_sales_records.category AS category,
      report_sales_records.gross_quantity AS grossQuantity,
      report_sales_records.return_quantity AS returnQuantity,
      report_sales_records.net_quantity AS netQuantity,
      report_sales_records.sales_amount AS salesAmount,
      report_sales_records.updated_by_email AS updatedByEmail,
      report_sales_records.updated_at AS updatedAt
      ${from}
      WHERE ${where}
      ORDER BY ${sql.raw(sortColumn)} ${sql.raw(direction)}, report_sales_records.id ASC
      LIMIT ${limit} OFFSET ${offset}`),
  ]);
  return {
    rows: rows.map((row) => ({
      id: textValue(row.id),
      source: row.source === "manual" ? "manual" : "imported",
      scopeId: textValue(row.scopeId),
      scopeName: textValue(row.scopeName),
      reportMonth: textValue(row.reportMonth),
      skuSource: row.skuSource === "custom" || row.skuSource === "cyberbiz" ? row.skuSource : null,
      sku: textValue(row.sku),
      productName: textValue(row.productName),
      category: textValue(row.category),
      grossQuantity: numberValue(row.grossQuantity),
      returnQuantity: numberValue(row.returnQuantity),
      netQuantity: numberValue(row.netQuantity),
      salesAmount: numberValue(row.salesAmount),
      updatedByEmail: textValue(row.updatedByEmail) || "系統匯入",
      updatedAt: textValue(row.updatedAt),
    })),
    page: query.page,
    pageSize: query.pageSize,
    total: numberValue(countRows[0]?.count),
  };
}

export async function listReportManualPayouts(db: Database): Promise<ReportManualPayoutRow[]> {
  const [rows, names] = await Promise.all([
    db.select().from(reportManualPayoutDaily)
      .orderBy(asc(reportManualPayoutDaily.businessDate), asc(reportManualPayoutDaily.id)),
    scopeNames(db),
  ]);
  return rows.map((row) => ({ ...row, scopeName: names.get(row.scopeId) ?? row.scopeId }));
}

export async function listReportManualSales(db: Database): Promise<ReportManualSalesRow[]> {
  const [rows, names] = await Promise.all([
    db.select().from(reportManualSalesMonthly)
      .orderBy(asc(reportManualSalesMonthly.reportMonth), asc(reportManualSalesMonthly.sku), asc(reportManualSalesMonthly.id)),
    scopeNames(db),
  ]);
  return rows.map((row) => ({ ...row, scopeName: names.get(row.scopeId) ?? row.scopeId }));
}

export async function createReportManualPayout(
  db: Database,
  input: ReportManualPayoutInput,
): Promise<ReportManualPayoutRow> {
  const prepared = await preparePayout(db, input);
  const [existing] = await db.select({ id: reportManualPayoutDaily.id })
    .from(reportManualPayoutDaily)
    .where(and(
      eq(reportManualPayoutDaily.scopeId, prepared.scopeId),
      eq(reportManualPayoutDaily.businessDate, prepared.businessDate),
    ))
    .limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點在這個日期已經有人工出金資料，請改用編輯。");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    scopeId: prepared.scopeId,
    businessDate: prepared.businessDate,
    payoutAmount: prepared.payoutAmount,
    createdById: input.actor.id,
    createdByEmail: input.actor.email,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db.insert(reportManualPayoutDaily).values(row),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate),
      eventType: "report_manual_payout_created",
      summary: `新增人工出金資料：${prepared.scope.name} ${prepared.businessDate}`,
      field: "payoutAmount",
      newValue: String(prepared.payoutAmount),
      payload: payoutPayload(prepared),
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...row, scopeName: prepared.scope.name };
}

export async function updateReportManualPayout(
  db: Database,
  input: ReportManualPayoutInput & { id: string },
): Promise<ReportManualPayoutRow> {
  const [existing] = await db.select().from(reportManualPayoutDaily)
    .where(eq(reportManualPayoutDaily.id, input.id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const prepared = await preparePayout(db, input);
  const [conflict] = await db.select({ id: reportManualPayoutDaily.id })
    .from(reportManualPayoutDaily)
    .where(and(
      eq(reportManualPayoutDaily.scopeId, prepared.scopeId),
      eq(reportManualPayoutDaily.businessDate, prepared.businessDate),
      ne(reportManualPayoutDaily.id, input.id),
    )).limit(1);
  if (conflict) throw new ReportManualError("conflict", "這個據點在這個日期已經有另一筆人工出金資料。");

  const updatedAt = new Date().toISOString();
  const next = {
    ...existing,
    scopeId: prepared.scopeId,
    businessDate: prepared.businessDate,
    payoutAmount: prepared.payoutAmount,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    updatedAt,
  };
  await db.batch([
    db.update(reportManualPayoutDaily).set({
      scopeId: next.scopeId,
      businessDate: next.businessDate,
      payoutAmount: next.payoutAmount,
      updatedById: next.updatedById,
      updatedByEmail: next.updatedByEmail,
      updatedAt: next.updatedAt,
    }).where(eq(reportManualPayoutDaily.id, input.id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: input.id,
      entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate),
      eventType: "report_manual_payout_updated",
      summary: `更新人工出金資料：${prepared.scope.name} ${prepared.businessDate}`,
      field: "payoutAmount",
      oldValue: String(existing.payoutAmount),
      newValue: String(prepared.payoutAmount),
      payload: { before: payoutPayload(existing), after: payoutPayload(prepared) },
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...next, scopeName: prepared.scope.name };
}

export async function deleteReportManualPayout(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const [existing] = await db.select().from(reportManualPayoutDaily)
    .where(eq(reportManualPayoutDaily.id, id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: payoutLabel(scopeName, existing.businessDate),
      eventType: "report_manual_payout_deleted",
      summary: `刪除人工出金資料：${scopeName} ${existing.businessDate}`,
      field: "payoutAmount",
      oldValue: String(existing.payoutAmount),
      payload: payoutPayload(existing),
      actor,
      source: "reports",
    })),
  ] as never);
}

/**
 * 刪除頁面目前看到的出金紀錄。
 *
 * 匯入列直接刪除原始資料；人工覆寫列則連同同一 key 的原始資料一起刪除，避免刪除後又立刻顯示回匯入值。
 */
export async function deleteReportPayoutRecord(
  db: Database,
  input: ReportPayoutRecordDeleteInput,
  actor: ReportManualActor,
): Promise<void> {
  const scopeId = input.scopeId.trim();
  const businessDate = input.businessDate.trim();
  if (!scopeId || !isValidReportDate(businessDate)) {
    throw new ReportManualError("invalid", "出金紀錄的據點或日期不正確。");
  }

  const [manual] = input.source === "manual"
    ? await db.select().from(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, input.id)).limit(1)
    : [];
  const [imported] = input.source === "imported"
    ? await db.select().from(reportPayoutDaily).where(and(
      eq(reportPayoutDaily.scopeId, scopeId),
      eq(reportPayoutDaily.businessDate, businessDate),
    )).limit(1)
    : [];
  const existing = manual ?? imported;
  if (!existing) throw new ReportManualError("not_found", "找不到這筆出金紀錄。");

  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  const entityId = input.source === "manual" ? input.id : `imported:${scopeId}:${businessDate}`;
  const payoutAmount = existing.payoutAmount;
  await db.batch([
    input.source === "manual"
      ? db.delete(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, input.id))
      : db.delete(reportPayoutDaily).where(and(
        eq(reportPayoutDaily.scopeId, scopeId),
        eq(reportPayoutDaily.businessDate, businessDate),
      )),
    ...(input.source === "manual"
      ? [db.delete(reportPayoutDaily).where(and(
        eq(reportPayoutDaily.scopeId, existing.scopeId),
        eq(reportPayoutDaily.businessDate, existing.businessDate),
      ))]
      : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId,
      entityLabel: payoutLabel(scopeName, existing.businessDate),
      eventType: "report_payout_record_deleted",
      summary: `刪除出金資料：${scopeName} ${existing.businessDate}`,
      field: "payoutAmount",
      oldValue: String(payoutAmount),
      payload: { source: input.source, ...payoutPayload(existing) },
      actor,
      source: "reports",
    })),
  ] as never);
}

export async function createReportManualSales(
  db: Database,
  input: ReportManualSalesInput,
): Promise<ReportManualSalesRow> {
  const prepared = await prepareSales(db, input);
  const [existing] = await db.select({ id: reportManualSalesMonthly.id })
    .from(reportManualSalesMonthly)
    .where(and(
      eq(reportManualSalesMonthly.scopeId, prepared.scopeId),
      eq(reportManualSalesMonthly.reportMonth, prepared.reportMonth),
      eq(reportManualSalesMonthly.sku, prepared.sku),
    )).limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有人工商品銷售資料，請改用編輯。");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    scopeId: prepared.scopeId,
    reportMonth: prepared.reportMonth,
    skuSource: prepared.skuSource,
    sku: prepared.sku,
    productName: prepared.productName,
    category: prepared.category,
    grossQuantity: prepared.grossQuantity,
    returnQuantity: prepared.returnQuantity,
    netQuantity: prepared.netQuantity,
    salesAmount: prepared.salesAmount,
    createdById: input.actor.id,
    createdByEmail: input.actor.email,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db.insert(reportManualSalesMonthly).values(row),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku),
      eventType: "report_manual_sales_created",
      summary: `新增人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`,
      payload: salesPayload(prepared),
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...row, scopeName: prepared.scope.name };
}

export async function updateReportManualSales(
  db: Database,
  input: ReportManualSalesInput & { id: string },
): Promise<ReportManualSalesRow> {
  const [existing] = await db.select().from(reportManualSalesMonthly)
    .where(eq(reportManualSalesMonthly.id, input.id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const prepared = await prepareSales(db, input);
  const [conflict] = await db.select({ id: reportManualSalesMonthly.id })
    .from(reportManualSalesMonthly)
    .where(and(
      eq(reportManualSalesMonthly.scopeId, prepared.scopeId),
      eq(reportManualSalesMonthly.reportMonth, prepared.reportMonth),
      eq(reportManualSalesMonthly.sku, prepared.sku),
      ne(reportManualSalesMonthly.id, input.id),
    )).limit(1);
  if (conflict) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有另一筆人工商品銷售資料。");

  const updatedAt = new Date().toISOString();
  const next = {
    ...existing,
    scopeId: prepared.scopeId,
    reportMonth: prepared.reportMonth,
    skuSource: prepared.skuSource,
    sku: prepared.sku,
    productName: prepared.productName,
    category: prepared.category,
    grossQuantity: prepared.grossQuantity,
    returnQuantity: prepared.returnQuantity,
    netQuantity: prepared.netQuantity,
    salesAmount: prepared.salesAmount,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    updatedAt,
  };
  await db.batch([
    db.update(reportManualSalesMonthly).set({
      scopeId: next.scopeId,
      reportMonth: next.reportMonth,
      skuSource: next.skuSource,
      sku: next.sku,
      productName: next.productName,
      category: next.category,
      grossQuantity: next.grossQuantity,
      returnQuantity: next.returnQuantity,
      netQuantity: next.netQuantity,
      salesAmount: next.salesAmount,
      updatedById: next.updatedById,
      updatedByEmail: next.updatedByEmail,
      updatedAt: next.updatedAt,
    }).where(eq(reportManualSalesMonthly.id, input.id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: input.id,
      entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku),
      eventType: "report_manual_sales_updated",
      summary: `更新人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`,
      oldValue: JSON.stringify(salesPayload(existing)),
      newValue: JSON.stringify(salesPayload(prepared)),
      payload: { before: salesPayload(existing), after: salesPayload(prepared) },
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...next, scopeName: prepared.scope.name };
}

export async function deleteReportManualSales(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const [existing] = await db.select().from(reportManualSalesMonthly)
    .where(eq(reportManualSalesMonthly.id, id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: salesLabel(scopeName, existing.reportMonth, existing.sku),
      eventType: "report_manual_sales_deleted",
      summary: `刪除人工商品銷售資料：${scopeName} ${existing.reportMonth} ${existing.sku}`,
      oldValue: JSON.stringify(salesPayload(existing)),
      payload: salesPayload(existing),
      actor,
      source: "reports",
    })),
  ] as never);
}

/** 刪除頁面目前看到的商品銷售紀錄，規則與出金有效紀錄一致。 */
export async function deleteReportSalesRecord(
  db: Database,
  input: ReportSalesRecordDeleteInput,
  actor: ReportManualActor,
): Promise<void> {
  const scopeId = input.scopeId.trim();
  const reportMonth = input.reportMonth.trim();
  const sku = normalizeExternalSku(input.sku);
  if (!scopeId || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth) || !sku) {
    throw new ReportManualError("invalid", "商品銷售紀錄的據點、月份或 SKU 不正確。");
  }

  const [manual] = input.source === "manual"
    ? await db.select().from(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, input.id)).limit(1)
    : [];
  const [imported] = input.source === "imported"
    ? await db.select().from(reportSalesMonthly).where(and(
      eq(reportSalesMonthly.scopeId, scopeId),
      eq(reportSalesMonthly.reportMonth, reportMonth),
      eq(reportSalesMonthly.sku, sku),
    )).limit(1)
    : [];
  const existing = manual ?? imported;
  if (!existing) throw new ReportManualError("not_found", "找不到這筆商品銷售紀錄。");

  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  const entityId = input.source === "manual"
    ? input.id
    : `imported:${scopeId}:${reportMonth}:${sku}`;
  await db.batch([
    input.source === "manual"
      ? db.delete(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, input.id))
      : db.delete(reportSalesMonthly).where(and(
        eq(reportSalesMonthly.scopeId, scopeId),
        eq(reportSalesMonthly.reportMonth, reportMonth),
        eq(reportSalesMonthly.sku, sku),
      )),
    ...(input.source === "manual"
      ? [db.delete(reportSalesMonthly).where(and(
        eq(reportSalesMonthly.scopeId, existing.scopeId),
        eq(reportSalesMonthly.reportMonth, existing.reportMonth),
        eq(reportSalesMonthly.sku, existing.sku),
      ))]
      : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId,
      entityLabel: salesLabel(scopeName, existing.reportMonth, existing.sku),
      eventType: "report_sales_record_deleted",
      summary: `刪除商品銷售資料：${scopeName} ${existing.reportMonth} ${existing.sku}`,
      oldValue: JSON.stringify(salesPayload({ ...existing, skuSource: "custom" })),
      payload: { source: input.source, ...salesPayload({ ...existing, skuSource: "custom" }) },
      actor,
      source: "reports",
    })),
  ] as never);
}
