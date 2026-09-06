import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { formatCyberbizProductName } from "./cyberbiz-product-name.js";
import { isCompanyReportStoreScopeId, isValidReportDate, normalizeReportScopeName, type ReportManualSkuSource } from "./report-data.js";
import { activityEvents } from "./schema/activity.js";
import {
  reportItemSalesMonthly,
  scopes as targetScopes,
  targetReportPayoutDaily,
} from "./schema/reports.js";
import { itemCategories, cyberbizProducts, items as itemMasters } from "./schema/items.js";
import { normalizeExternalSku } from "./product-sku-mappings.js";

function targetPayoutRecordId(scopeId: string, businessDate: string): string {
  return `target:${scopeId}:${businessDate}`;
}

function targetSalesRecordId(scopeId: string, reportMonth: string, itemId: string): string {
  return `target:${scopeId}:${reportMonth}:${itemId}`;
}

export interface ReportManualActor {
  id: string;
  email: string;
}

export type ReportManualErrorKind = "invalid" | "not_found" | "conflict";

export class ReportManualError extends Error {
  constructor(readonly kind: ReportManualErrorKind, message: string) {
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
  categoryId?: string | null;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  actor: ReportManualActor;
}

export type ReportManualPayoutRow = ReportPayoutRecord;
export type ReportManualSalesRow = ReportSalesRecord;
export type ReportManualRecordSource = "imported" | "manual";

export interface ReportPayoutFilters {
  scopeId?: string;
  source?: ReportManualRecordSource;
  search?: string;
  startDate?: string;
  endDate?: string;
}

export interface ReportPayoutListQuery extends ReportPayoutFilters {
  page: number;
  pageSize: number;
  sortField: "scope" | "businessDate" | "payoutAmount" | "updatedAt";
  sortDirection: "asc" | "desc";
}

export interface ReportSalesFilters {
  scopeId?: string;
  source?: ReportManualRecordSource;
  search?: string;
  startMonth?: string;
  endMonth?: string;
}

export interface ReportSalesListQuery extends ReportSalesFilters {
  page: number;
  pageSize: number;
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

export interface ReportPayoutListPage { rows: ReportPayoutRecord[]; page: number; pageSize: number }
export interface ReportSalesListPage { rows: ReportSalesRecord[]; page: number; pageSize: number }

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

export interface ReportManagementScope { id: string; name: string; active: boolean }
export interface ReportManagementScopeInput { id: string; name: string; active?: boolean }

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ReportManualError("invalid", `${label}必須是安全整數。`);
  return value;
}

async function requireScope(db: Database, scopeId: string) {
  const id = scopeId.trim();
  if (!id) throw new ReportManualError("invalid", "請選擇據點。");
  const [scope] = await db.select({ id: targetScopes.id, name: targetScopes.name })
    .from(targetScopes)
    .where(and(eq(targetScopes.id, id), eq(targetScopes.scopeKind, "store")))
    .limit(1);
  if (!scope || !isCompanyReportStoreScopeId(scope.id)) {
    throw new ReportManualError("not_found", "找不到可納入公司報表的啟用據點。");
  }
  return scope;
}

export async function listReportManagementScopes(db: Database): Promise<ReportManagementScope[]> {
  const rows = await db.select({ id: targetScopes.id, name: targetScopes.name, active: targetScopes.active })
    .from(targetScopes)
    .where(eq(targetScopes.scopeKind, "store"))
    .orderBy(desc(targetScopes.active), asc(targetScopes.name));
  return rows.filter((scope) => isCompanyReportStoreScopeId(scope.id)).map((scope) => ({ ...scope, active: scope.active === 1 }));
}

export async function createReportManagementScope(db: Database, input: ReportManagementScopeInput): Promise<ReportManagementScope> {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id || !isCompanyReportStoreScopeId(id) || !name) throw new ReportManualError("invalid", "據點 ID 或名稱不正確。");
  const normalizedName = normalizeReportScopeName(name);
  const [existingId] = await db.select({ id: targetScopes.id }).from(targetScopes).where(eq(targetScopes.id, id)).limit(1);
  if (existingId) throw new ReportManualError("conflict", "這個據點 ID 已經存在。");
  const [existingName] = await db.select({ id: targetScopes.id }).from(targetScopes).where(and(
    eq(targetScopes.scopeKind, "store"), eq(targetScopes.normalizedName, normalizedName),
  )).limit(1);
  if (existingName) throw new ReportManualError("conflict", "這個據點名稱已經存在。");
  const now = new Date().toISOString();
  await db.insert(targetScopes).values({
    id, sourceType: "report", scopeKind: "store", name, normalizedName,
    driveFolderUrl: "", driveFolderName: "", sortOrder: 0, active: input.active === false ? 0 : 1,
    createdAt: now, updatedAt: now,
  });
  return { id, name, active: input.active !== false };
}

export async function updateReportManagementScope(
  db: Database,
  input: { id: string; name?: string; active?: boolean },
): Promise<ReportManagementScope> {
  const id = input.id.trim();
  if (!id || !isCompanyReportStoreScopeId(id)) throw new ReportManualError("invalid", "據點 ID 不正確。");
  const [existing] = await db.select({ id: targetScopes.id, name: targetScopes.name, active: targetScopes.active })
    .from(targetScopes).where(and(eq(targetScopes.id, id), eq(targetScopes.scopeKind, "store"))).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這個據點。");
  const name = input.name === undefined ? existing.name : input.name.trim();
  if (!name) throw new ReportManualError("invalid", "據點名稱不可為空白。");
  if (name !== existing.name) {
    const [duplicate] = await db.select({ id: targetScopes.id }).from(targetScopes).where(and(
      eq(targetScopes.scopeKind, "store"), eq(targetScopes.normalizedName, normalizeReportScopeName(name)), ne(targetScopes.id, id),
    )).limit(1);
    if (duplicate) throw new ReportManualError("conflict", "這個據點名稱已經存在。");
  }
  const active = input.active === undefined ? existing.active === 1 : input.active;
  await db.update(targetScopes).set({ name, normalizedName: normalizeReportScopeName(name), active: active ? 1 : 0, updatedAt: new Date().toISOString() })
    .where(eq(targetScopes.id, id));
  return { id, name, active };
}

async function preparePayout(db: Database, input: Omit<ReportManualPayoutInput, "actor">) {
  const scope = await requireScope(db, input.scopeId);
  const businessDate = input.businessDate.trim();
  if (!isValidReportDate(businessDate)) throw new ReportManualError("invalid", "出金日期必須是有效的 YYYY-MM-DD。");
  return { scope, scopeId: scope.id, businessDate, payoutAmount: safeInteger(input.payoutAmount, "出金金額") };
}

async function prepareSales(db: Database, input: Omit<ReportManualSalesInput, "actor">) {
  const scope = await requireScope(db, input.scopeId);
  const reportMonth = input.reportMonth.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth)) throw new ReportManualError("invalid", "商品銷售月份必須是有效的 YYYY-MM。");
  if (input.skuSource !== "custom" && input.skuSource !== "cyberbiz") throw new ReportManualError("invalid", "SKU 來源不正確。");
  const sku = normalizeExternalSku(input.sku);
  if (!sku) throw new ReportManualError("invalid", "請填寫 SKU。");

  let productName = (input.productName ?? "").trim();
  let category = (input.category ?? "").trim() || "未分類";
  if (input.skuSource === "cyberbiz") {
    const [product] = await db.select({ productName: cyberbizProducts.productName, variantName: cyberbizProducts.variantName, categoryName: itemCategories.name })
      .from(cyberbizProducts)
      .innerJoin(itemMasters, eq(itemMasters.id, cyberbizProducts.itemId))
      .leftJoin(itemCategories, eq(itemCategories.id, itemMasters.categoryId))
      .where(eq(itemMasters.sku, sku)).limit(1);
    if (!product) throw new ReportManualError("not_found", `找不到 CYBERBIZ SKU「${sku}」。`);
    productName = formatCyberbizProductName(product);
    category = product.categoryName ?? "未分類";
  } else if (input.categoryId !== undefined) {
    const categoryId = input.categoryId?.trim() ?? "";
    if (categoryId) {
      const [selected] = await db.select({ name: itemCategories.name }).from(itemCategories).where(eq(itemCategories.id, categoryId)).limit(1);
      if (!selected) throw new ReportManualError("not_found", "找不到指定商品分類。");
      category = selected.name;
    } else {
      category = "未分類";
    }
  }
  if (input.skuSource === "custom" && !productName) throw new ReportManualError("invalid", "自訂 SKU 必須填寫商品名稱。");
  return {
    scope, scopeId: scope.id, reportMonth, skuSource: input.skuSource, sku,
    productName: productName || sku, category,
    grossQuantity: safeInteger(input.grossQuantity, "銷售數量"),
    returnQuantity: safeInteger(input.returnQuantity, "退貨數量"),
    netQuantity: safeInteger(input.netQuantity, "淨銷售數量"),
    salesAmount: safeInteger(input.salesAmount, "銷售金額"),
  };
}

function payoutLabel(scopeName: string, businessDate: string): string { return `出金 · ${scopeName} · ${businessDate}`; }
function salesLabel(scopeName: string, reportMonth: string, sku: string): string { return `商品銷售 · ${scopeName} · ${reportMonth} · ${sku}`; }
function payoutPayload(row: { scopeId: string; businessDate: string; payoutAmount: number }) { return { reportKind: "payout", scopeId: row.scopeId, businessDate: row.businessDate, payoutAmount: row.payoutAmount }; }
function salesPayload(row: { scopeId: string; reportMonth: string; skuSource: ReportManualSkuSource | null; sku: string; productName: string; category: string; grossQuantity: number; returnQuantity: number; netQuantity: number; salesAmount: number }) {
  return { reportKind: "sales", scopeId: row.scopeId, reportMonth: row.reportMonth, skuSource: row.skuSource, sku: row.sku, productName: row.productName, category: row.category, grossQuantity: row.grossQuantity, returnQuantity: row.returnQuantity, netQuantity: row.netQuantity, salesAmount: row.salesAmount };
}

async function scopeNames(db: Database): Promise<Map<string, string>> {
  const rows = await db.select({ id: targetScopes.id, name: targetScopes.name }).from(targetScopes);
  return new Map(rows.map((scope) => [scope.id, scope.name]));
}

const PAYOUT_RECORD_SOURCE = sql`(
  SELECT
    CASE WHEN target.record_origin = 'manual' THEN 'manual' ELSE 'imported' END AS source,
    'target:' || target.scope_id || ':' || target.business_date AS id,
    target.scope_id, target.business_date, target.payout_amount,
    CASE WHEN target.record_origin = 'manual' THEN target.updated_by_email ELSE '系統匯入' END AS updated_by_email,
    target.updated_at
  FROM report_payout_daily_target AS target
  WHERE target.record_origin = 'manual'
    OR NOT EXISTS (
      SELECT 1 FROM report_payout_daily_target AS manual
      WHERE manual.scope_id = target.scope_id AND manual.business_date = target.business_date AND manual.record_origin = 'manual'
    )
) AS report_payout_records`;

const SALES_RECORD_SOURCE = sql`(
  SELECT
    CASE WHEN sales.record_origin = 'manual' THEN 'manual' ELSE 'imported' END AS source,
    'target:' || sales.scope_id || ':' || sales.report_month || ':' || sales.item_id AS id,
    sales.scope_id, sales.report_month, item.source AS sku_source, item.sku, item.name AS product_name,
    COALESCE(category.name, '未分類') AS category, sales.gross_quantity, sales.return_quantity,
    sales.net_quantity, sales.sales_amount,
    CASE WHEN sales.record_origin = 'manual' THEN sales.updated_by_email ELSE '系統匯入' END AS updated_by_email,
    sales.updated_at
  FROM report_item_sales_monthly AS sales
  JOIN items AS item ON item.id = sales.item_id
  LEFT JOIN item_categories AS category ON category.id = item.category_id
  WHERE sales.record_origin = 'manual'
    OR NOT EXISTS (
      SELECT 1 FROM report_item_sales_monthly AS manual
      WHERE manual.scope_id = sales.scope_id AND manual.report_month = sales.report_month
        AND manual.item_id = sales.item_id AND manual.record_origin = 'manual'
    )
) AS report_sales_records`;

function textValue(value: unknown): string { return typeof value === "string" ? value : String(value ?? ""); }
function numberValue(value: unknown): number { return typeof value === "number" ? value : Number(value ?? 0); }
function listLimit(query: { page: number; pageSize: number }): { limit: number; offset: number } { return { limit: query.pageSize, offset: Math.max(0, query.page - 1) * query.pageSize }; }

function payoutRecordScope(query: ReportPayoutFilters) {
  const conditions = [sql`1 = 1`];
  if (query.scopeId) conditions.push(sql`report_payout_records.scope_id = ${query.scopeId}`);
  if (query.source) conditions.push(sql`report_payout_records.source = ${query.source}`);
  if (query.startDate) conditions.push(sql`report_payout_records.business_date >= ${query.startDate}`);
  if (query.endDate) conditions.push(sql`report_payout_records.business_date <= ${query.endDate}`);
  const search = query.search?.trim();
  if (search) {
    const term = `%${search}%`;
    conditions.push(sql`(lower(COALESCE(report_scopes.name, report_payout_records.scope_id)) LIKE lower(${term}) OR report_payout_records.business_date LIKE ${term})`);
  }
  return { where: sql.join(conditions, sql` AND `), from: sql`FROM ${PAYOUT_RECORD_SOURCE} LEFT JOIN scopes AS report_scopes ON report_scopes.id = report_payout_records.scope_id` };
}

export async function countReportPayoutRecords(db: Database, query: ReportPayoutFilters): Promise<number> {
  const { where, from } = payoutRecordScope(query);
  const rows = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count ${from} WHERE ${where}`);
  return numberValue(rows[0]?.count);
}

export async function listReportPayoutRecords(db: Database, query: ReportPayoutListQuery): Promise<ReportPayoutListPage> {
  const { where, from } = payoutRecordScope(query);
  const sortColumns = { scope: "COALESCE(report_scopes.name, report_payout_records.scope_id)", businessDate: "report_payout_records.business_date", payoutAmount: "report_payout_records.payout_amount", updatedAt: "report_payout_records.updated_at" } as const;
  const direction = query.sortDirection === "asc" ? "ASC" : "DESC";
  const { limit, offset } = listLimit(query);
  const rows = await db.all<Record<string, unknown>>(sql`SELECT
    report_payout_records.id AS id, report_payout_records.source AS source,
    report_payout_records.scope_id AS scopeId, COALESCE(report_scopes.name, report_payout_records.scope_id) AS scopeName,
    report_payout_records.business_date AS businessDate, report_payout_records.payout_amount AS payoutAmount,
    report_payout_records.updated_by_email AS updatedByEmail, report_payout_records.updated_at AS updatedAt
    ${from} WHERE ${where}
    ORDER BY ${sql.raw(sortColumns[query.sortField] ?? sortColumns.businessDate)} ${sql.raw(direction)}, report_payout_records.id ASC
    LIMIT ${limit} OFFSET ${offset}`);
  return {
    rows: rows.map((row) => ({ id: textValue(row.id), source: row.source === "manual" ? "manual" : "imported", scopeId: textValue(row.scopeId), scopeName: textValue(row.scopeName), businessDate: textValue(row.businessDate), payoutAmount: numberValue(row.payoutAmount), updatedByEmail: textValue(row.updatedByEmail) || "系統匯入", updatedAt: textValue(row.updatedAt) })),
    page: query.page, pageSize: query.pageSize,
  };
}

function salesRecordScope(query: ReportSalesFilters) {
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
  return { where: sql.join(conditions, sql` AND `), from: sql`FROM ${SALES_RECORD_SOURCE} LEFT JOIN scopes AS report_scopes ON report_scopes.id = report_sales_records.scope_id` };
}

export async function countReportSalesRecords(db: Database, query: ReportSalesFilters): Promise<number> {
  const { where, from } = salesRecordScope(query);
  const rows = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count ${from} WHERE ${where}`);
  return numberValue(rows[0]?.count);
}

export async function listReportSalesRecords(db: Database, query: ReportSalesListQuery): Promise<ReportSalesListPage> {
  const { where, from } = salesRecordScope(query);
  const sortColumns = { scope: "COALESCE(report_scopes.name, report_sales_records.scope_id)", reportMonth: "report_sales_records.report_month", sku: "report_sales_records.sku", productName: "report_sales_records.product_name", netQuantity: "report_sales_records.net_quantity", salesAmount: "report_sales_records.sales_amount", updatedAt: "report_sales_records.updated_at" } as const;
  const direction = query.sortDirection === "asc" ? "ASC" : "DESC";
  const { limit, offset } = listLimit(query);
  const rows = await db.all<Record<string, unknown>>(sql`SELECT
    report_sales_records.id AS id, report_sales_records.source AS source,
    report_sales_records.scope_id AS scopeId, COALESCE(report_scopes.name, report_sales_records.scope_id) AS scopeName,
    report_sales_records.report_month AS reportMonth, report_sales_records.sku_source AS skuSource,
    report_sales_records.sku AS sku, report_sales_records.product_name AS productName,
    report_sales_records.category AS category, report_sales_records.gross_quantity AS grossQuantity,
    report_sales_records.return_quantity AS returnQuantity, report_sales_records.net_quantity AS netQuantity,
    report_sales_records.sales_amount AS salesAmount, report_sales_records.updated_by_email AS updatedByEmail,
    report_sales_records.updated_at AS updatedAt
    ${from} WHERE ${where}
    ORDER BY ${sql.raw(sortColumns[query.sortField] ?? sortColumns.reportMonth)} ${sql.raw(direction)}, report_sales_records.id ASC
    LIMIT ${limit} OFFSET ${offset}`);
  return {
    rows: rows.map((row) => ({ id: textValue(row.id), source: row.source === "manual" ? "manual" : "imported", scopeId: textValue(row.scopeId), scopeName: textValue(row.scopeName), reportMonth: textValue(row.reportMonth), skuSource: row.skuSource === "custom" || row.skuSource === "cyberbiz" ? row.skuSource : null, sku: textValue(row.sku), productName: textValue(row.productName), category: textValue(row.category), grossQuantity: numberValue(row.grossQuantity), returnQuantity: numberValue(row.returnQuantity), netQuantity: numberValue(row.netQuantity), salesAmount: numberValue(row.salesAmount), updatedByEmail: textValue(row.updatedByEmail) || "系統匯入", updatedAt: textValue(row.updatedAt) })),
    page: query.page, pageSize: query.pageSize,
  };
}

export async function listReportManualPayouts(db: Database): Promise<ReportManualPayoutRow[]> {
  const names = await scopeNames(db);
  const rows = await db.select().from(targetReportPayoutDaily).where(eq(targetReportPayoutDaily.recordOrigin, "manual"))
    .orderBy(asc(targetReportPayoutDaily.businessDate), asc(targetReportPayoutDaily.scopeId));
  return rows.map((row) => ({ id: targetPayoutRecordId(row.scopeId, row.businessDate), source: "manual", scopeId: row.scopeId, scopeName: names.get(row.scopeId) ?? row.scopeId, businessDate: row.businessDate, payoutAmount: row.payoutAmount, updatedByEmail: row.updatedByEmail, updatedAt: row.updatedAt }));
}

export async function listReportManualSales(db: Database): Promise<ReportManualSalesRow[]> {
  const [rows, names, categories] = await Promise.all([
    db.select({ sales: reportItemSalesMonthly, item: itemMasters }).from(reportItemSalesMonthly).innerJoin(itemMasters, eq(itemMasters.id, reportItemSalesMonthly.itemId)).where(eq(reportItemSalesMonthly.recordOrigin, "manual")).orderBy(asc(reportItemSalesMonthly.reportMonth), asc(itemMasters.sku), asc(reportItemSalesMonthly.itemId)),
    scopeNames(db),
    db.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories),
  ]);
  const categoryById = new Map(categories.map((category) => [category.id, category.name]));
  return rows.map(({ sales, item }) => ({ id: targetSalesRecordId(sales.scopeId, sales.reportMonth, sales.itemId), source: "manual", scopeId: sales.scopeId, scopeName: names.get(sales.scopeId) ?? sales.scopeId, reportMonth: sales.reportMonth, skuSource: item.source, sku: item.sku, productName: item.name, category: categoryById.get(item.categoryId ?? "") ?? "未分類", grossQuantity: sales.grossQuantity, returnQuantity: sales.returnQuantity, netQuantity: sales.netQuantity, salesAmount: sales.salesAmount, updatedByEmail: sales.updatedByEmail, updatedAt: sales.updatedAt }));
}

async function ensureTargetSalesItem(db: Database, prepared: Awaited<ReturnType<typeof prepareSales>>, now: string) {
  const [category] = prepared.category !== "未分類"
    ? await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, prepared.category)).limit(1)
    : [];
  // SKU 是全平台唯一（items 的 idx_items_sku），所以不能只找同一個 source：人工報表
  // 輸入的 SKU 若已經是官網鏡像，這裡找不到就會往下插一筆新的，直接撞在索引上。
  const [existing] = await db.select({ id: itemMasters.id, source: itemMasters.source, categoryId: itemMasters.categoryId }).from(itemMasters)
    .where(eq(itemMasters.sku, prepared.sku)).limit(1);
  if (existing) {
    // 官網鏡像的名稱與分類由同步負責，人工報表不覆蓋。
    if (existing.source === "custom") await db.update(itemMasters).set({ name: prepared.productName, categoryId: category?.id ?? null, updatedAt: now }).where(eq(itemMasters.id, existing.id));
    return { id: existing.id };
  }
  const id = crypto.randomUUID();
  await db.insert(itemMasters).values({ id, source: prepared.skuSource, kind: "sellable", sku: prepared.sku, name: prepared.productName, categoryId: category?.id ?? null, active: 1, createdAt: now, updatedAt: now });
  return { id };
}

async function findTargetManualPayout(db: Database, id: string) {
  const [row] = await db.select().from(targetReportPayoutDaily).where(and(
    eq(targetReportPayoutDaily.recordOrigin, "manual"),
    sql`'target:' || ${targetReportPayoutDaily.scopeId} || ':' || ${targetReportPayoutDaily.businessDate} = ${id}`,
  )).limit(1);
  return row ?? null;
}

async function findTargetManualSales(db: Database, id: string) {
  const rows = await db.select({ sales: reportItemSalesMonthly, item: itemMasters }).from(reportItemSalesMonthly)
    .innerJoin(itemMasters, eq(itemMasters.id, reportItemSalesMonthly.itemId)).where(eq(reportItemSalesMonthly.recordOrigin, "manual"));
  return rows.find(({ sales }) => targetSalesRecordId(sales.scopeId, sales.reportMonth, sales.itemId) === id) ?? null;
}

function targetSalesRecord(
  row: { sales: typeof reportItemSalesMonthly.$inferSelect; item: typeof itemMasters.$inferSelect },
  scopeName: string,
  category: string,
): ReportSalesRecord {
  return { id: targetSalesRecordId(row.sales.scopeId, row.sales.reportMonth, row.sales.itemId), source: "manual", scopeId: row.sales.scopeId, scopeName, reportMonth: row.sales.reportMonth, skuSource: row.item.source, sku: row.item.sku, productName: row.item.name, category, grossQuantity: row.sales.grossQuantity, returnQuantity: row.sales.returnQuantity, netQuantity: row.sales.netQuantity, salesAmount: row.sales.salesAmount, updatedByEmail: row.sales.updatedByEmail || "系統匯入", updatedAt: row.sales.updatedAt };
}

async function createTargetManualPayout(db: Database, input: ReportManualPayoutInput): Promise<ReportManualPayoutRow> {
  const prepared = await preparePayout(db, input);
  const [existing] = await db.select().from(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, prepared.scopeId), eq(targetReportPayoutDaily.businessDate, prepared.businessDate), eq(targetReportPayoutDaily.recordOrigin, "manual"))).limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點在這個日期已經有人工出金資料，請改用編輯。");
  const id = targetPayoutRecordId(prepared.scopeId, prepared.businessDate);
  const now = new Date().toISOString();
  await db.batch([
    db.insert(targetReportPayoutDaily).values({ scopeId: prepared.scopeId, businessDate: prepared.businessDate, recordOrigin: "manual", reportRunId: null, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, createdAt: now, updatedAt: now }),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate), eventType: "report_manual_payout_created", summary: `新增人工出金資料：${prepared.scope.name} ${prepared.businessDate}`, field: "payoutAmount", newValue: String(prepared.payoutAmount), payload: payoutPayload(prepared), actor: input.actor, source: "reports" })),
  ] as never);
  return { id, source: "manual", scopeId: prepared.scopeId, scopeName: prepared.scope.name, businessDate: prepared.businessDate, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, updatedAt: now };
}

export const createReportManualPayout = createTargetManualPayout;

async function updateTargetManualPayout(db: Database, input: ReportManualPayoutInput & { id: string }): Promise<ReportManualPayoutRow> {
  const existing = await findTargetManualPayout(db, input.id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const prepared = await preparePayout(db, input);
  const [conflict] = await db.select({ scopeId: targetReportPayoutDaily.scopeId }).from(targetReportPayoutDaily).where(and(
    eq(targetReportPayoutDaily.scopeId, prepared.scopeId), eq(targetReportPayoutDaily.businessDate, prepared.businessDate), eq(targetReportPayoutDaily.recordOrigin, "manual"),
    sql`NOT (${targetReportPayoutDaily.scopeId} = ${existing.scopeId} AND ${targetReportPayoutDaily.businessDate} = ${existing.businessDate})`,
  )).limit(1);
  if (conflict) throw new ReportManualError("conflict", "這個據點在這個日期已經有另一筆人工出金資料。");
  const updatedAt = new Date().toISOString();
  const id = targetPayoutRecordId(prepared.scopeId, prepared.businessDate);
  await db.batch([
    db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, existing.scopeId), eq(targetReportPayoutDaily.businessDate, existing.businessDate), eq(targetReportPayoutDaily.recordOrigin, "manual"))),
    db.insert(targetReportPayoutDaily).values({ scopeId: prepared.scopeId, businessDate: prepared.businessDate, recordOrigin: "manual", reportRunId: null, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, updatedAt }).onConflictDoUpdate({ target: [targetReportPayoutDaily.scopeId, targetReportPayoutDaily.businessDate, targetReportPayoutDaily.recordOrigin], set: { payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, updatedAt } }),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate), eventType: "report_manual_payout_updated", summary: `更新人工出金資料：${prepared.scope.name} ${prepared.businessDate}`, field: "payoutAmount", oldValue: String(existing.payoutAmount), newValue: String(prepared.payoutAmount), payload: { before: payoutPayload(existing), after: payoutPayload(prepared) }, actor: input.actor, source: "reports" })),
  ] as never);
  return { id, source: "manual", scopeId: prepared.scopeId, scopeName: prepared.scope.name, businessDate: prepared.businessDate, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, updatedAt };
}

export const updateReportManualPayout = updateTargetManualPayout;

export async function deleteReportManualPayout(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const existing = await findTargetManualPayout(db, id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, existing.scopeId), eq(targetReportPayoutDaily.businessDate, existing.businessDate), eq(targetReportPayoutDaily.recordOrigin, "manual"))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: payoutLabel(scopeName, existing.businessDate), eventType: "report_manual_payout_deleted", summary: `刪除人工出金資料：${scopeName} ${existing.businessDate}`, field: "payoutAmount", oldValue: String(existing.payoutAmount), payload: payoutPayload(existing), actor, source: "reports" })),
  ] as never);
}

export async function deleteReportPayoutRecord(db: Database, input: ReportPayoutRecordDeleteInput, actor: ReportManualActor): Promise<void> {
  const scopeId = input.scopeId.trim();
  const businessDate = input.businessDate.trim();
  if (!scopeId || !isValidReportDate(businessDate)) throw new ReportManualError("invalid", "出金紀錄的據點或日期不正確。");
  const [existing] = await db.select().from(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, scopeId), eq(targetReportPayoutDaily.businessDate, businessDate), eq(targetReportPayoutDaily.recordOrigin, input.source))).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆出金紀錄。");
  const names = await scopeNames(db);
  const scopeName = names.get(scopeId) ?? scopeId;
  await db.batch([
    db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, scopeId), eq(targetReportPayoutDaily.businessDate, businessDate), eq(targetReportPayoutDaily.recordOrigin, input.source))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: payoutLabel(scopeName, businessDate), eventType: "report_payout_record_deleted", summary: `刪除出金資料：${scopeName} ${businessDate}`, field: "payoutAmount", oldValue: String(existing.payoutAmount), payload: { source: input.source, ...payoutPayload(existing) }, actor, source: "reports" })),
  ] as never);
}

export async function deleteReportPayoutRecords(db: Database, inputs: readonly ReportPayoutRecordDeleteInput[], actor: ReportManualActor): Promise<number> {
  if (!inputs.length) throw new ReportManualError("invalid", "至少要選取一筆出金紀錄。");
  const unique = new Map<string, ReportPayoutRecordDeleteInput>();
  for (const input of inputs) {
    const normalized = { ...input, id: input.id.trim(), scopeId: input.scopeId.trim(), businessDate: input.businessDate.trim() };
    if (!normalized.id || !normalized.scopeId || !isValidReportDate(normalized.businessDate)) throw new ReportManualError("invalid", "出金紀錄的據點、日期或 ID 不正確。");
    const key = `${normalized.source}:${normalized.scopeId}:${normalized.businessDate}`;
    if (!unique.has(key)) unique.set(key, normalized);
  }
  for (const input of unique.values()) await deleteReportPayoutRecord(db, input, actor);
  return unique.size;
}

async function createTargetManualSales(db: Database, input: ReportManualSalesInput): Promise<ReportManualSalesRow> {
  const prepared = await prepareSales(db, input);
  const now = new Date().toISOString();
  const matchedItem = await ensureTargetSalesItem(db, prepared, now);
  const [existing] = await db.select({ itemId: reportItemSalesMonthly.itemId }).from(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, prepared.scopeId), eq(reportItemSalesMonthly.reportMonth, prepared.reportMonth), eq(reportItemSalesMonthly.itemId, matchedItem.id), eq(reportItemSalesMonthly.recordOrigin, "manual"))).limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有人工商品銷售資料，請改用編輯。");
  const row = { scopeId: prepared.scopeId, reportMonth: prepared.reportMonth, itemId: matchedItem.id, recordOrigin: "manual" as const, reportRunId: null, grossQuantity: prepared.grossQuantity, returnQuantity: prepared.returnQuantity, netQuantity: prepared.netQuantity, salesAmount: prepared.salesAmount, updatedByEmail: input.actor.email, createdAt: now, updatedAt: now };
  const id = targetSalesRecordId(row.scopeId, row.reportMonth, row.itemId);
  await db.batch([
    db.insert(reportItemSalesMonthly).values(row),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku), eventType: "report_manual_sales_created", summary: `新增人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`, payload: salesPayload(prepared), actor: input.actor, source: "reports" })),
  ] as never);
  return targetSalesRecord({ sales: row, item: { ...matchedItem, source: prepared.skuSource, sku: prepared.sku, name: prepared.productName } as typeof itemMasters.$inferSelect }, prepared.scope.name, prepared.category);
}

export const createReportManualSales = createTargetManualSales;

export async function updateReportManualSales(db: Database, input: ReportManualSalesInput & { id: string }): Promise<ReportManualSalesRow> {
  const existing = await findTargetManualSales(db, input.id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const prepared = await prepareSales(db, input);
  const now = new Date().toISOString();
  const matchedItem = await ensureTargetSalesItem(db, prepared, now);
  const [conflict] = await db.select({ itemId: reportItemSalesMonthly.itemId }).from(reportItemSalesMonthly).where(and(
    eq(reportItemSalesMonthly.scopeId, prepared.scopeId), eq(reportItemSalesMonthly.reportMonth, prepared.reportMonth), eq(reportItemSalesMonthly.itemId, matchedItem.id), eq(reportItemSalesMonthly.recordOrigin, "manual"),
    sql`NOT (${reportItemSalesMonthly.scopeId} = ${existing.sales.scopeId} AND ${reportItemSalesMonthly.reportMonth} = ${existing.sales.reportMonth} AND ${reportItemSalesMonthly.itemId} = ${existing.sales.itemId})`,
  )).limit(1);
  if (conflict) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有另一筆人工商品銷售資料。");
  const next = { scopeId: prepared.scopeId, reportMonth: prepared.reportMonth, itemId: matchedItem.id, recordOrigin: "manual" as const, reportRunId: null, grossQuantity: prepared.grossQuantity, returnQuantity: prepared.returnQuantity, netQuantity: prepared.netQuantity, salesAmount: prepared.salesAmount, updatedByEmail: input.actor.email, updatedAt: now };
  await db.batch([
    db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, existing.sales.scopeId), eq(reportItemSalesMonthly.reportMonth, existing.sales.reportMonth), eq(reportItemSalesMonthly.itemId, existing.sales.itemId), eq(reportItemSalesMonthly.recordOrigin, "manual"))),
    db.insert(reportItemSalesMonthly).values({ ...next, createdAt: existing.sales.createdAt }).onConflictDoUpdate({ target: [reportItemSalesMonthly.scopeId, reportItemSalesMonthly.reportMonth, reportItemSalesMonthly.itemId, reportItemSalesMonthly.recordOrigin], set: { grossQuantity: next.grossQuantity, returnQuantity: next.returnQuantity, netQuantity: next.netQuantity, salesAmount: next.salesAmount, updatedByEmail: next.updatedByEmail, updatedAt: next.updatedAt } }),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku), eventType: "report_manual_sales_updated", summary: `更新人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`, payload: { before: salesPayload({ ...existing.sales, skuSource: existing.item.source, sku: existing.item.sku, productName: existing.item.name, category: "未分類" }), after: salesPayload(prepared) }, actor: input.actor, source: "reports" })),
  ] as never);
  return targetSalesRecord({ sales: { ...next, createdAt: existing.sales.createdAt }, item: { ...matchedItem, source: prepared.skuSource, sku: prepared.sku, name: prepared.productName } as typeof itemMasters.$inferSelect }, prepared.scope.name, prepared.category);
}

export async function deleteReportManualSales(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const existing = await findTargetManualSales(db, id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.sales.scopeId) ?? existing.sales.scopeId;
  await db.batch([
    db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, existing.sales.scopeId), eq(reportItemSalesMonthly.reportMonth, existing.sales.reportMonth), eq(reportItemSalesMonthly.itemId, existing.sales.itemId), eq(reportItemSalesMonthly.recordOrigin, "manual"))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: salesLabel(scopeName, existing.sales.reportMonth, existing.item.sku), eventType: "report_manual_sales_deleted", summary: `刪除人工商品銷售資料：${scopeName} ${existing.sales.reportMonth} ${existing.item.sku}`, payload: salesPayload({ ...existing.sales, skuSource: existing.item.source, sku: existing.item.sku, productName: existing.item.name, category: "未分類" }), actor, source: "reports" })),
  ] as never);
}

async function deleteTargetSalesRecord(db: Database, input: ReportSalesRecordDeleteInput, actor: ReportManualActor): Promise<void> {
  const rows = await db.select({ sales: reportItemSalesMonthly, item: itemMasters }).from(reportItemSalesMonthly)
    .innerJoin(itemMasters, eq(itemMasters.id, reportItemSalesMonthly.itemId)).where(and(eq(reportItemSalesMonthly.scopeId, input.scopeId), eq(reportItemSalesMonthly.reportMonth, input.reportMonth), eq(reportItemSalesMonthly.recordOrigin, input.source)));
  const existing = input.source === "manual"
    ? rows.find(({ sales }) => targetSalesRecordId(sales.scopeId, sales.reportMonth, sales.itemId) === input.id)
    : rows.find(({ item }) => normalizeExternalSku(item.sku) === normalizeExternalSku(input.sku));
  if (!existing) throw new ReportManualError("not_found", "找不到這筆商品銷售紀錄。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.sales.scopeId) ?? existing.sales.scopeId;
  const payload = salesPayload({ ...existing.sales, skuSource: existing.item.source, sku: existing.item.sku, productName: existing.item.name, category: "未分類" });
  await db.batch([
    db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, existing.sales.scopeId), eq(reportItemSalesMonthly.reportMonth, existing.sales.reportMonth), eq(reportItemSalesMonthly.itemId, existing.sales.itemId), eq(reportItemSalesMonthly.recordOrigin, existing.sales.recordOrigin))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: salesLabel(scopeName, existing.sales.reportMonth, existing.item.sku), eventType: "report_sales_record_deleted", summary: `刪除商品銷售資料：${scopeName} ${existing.sales.reportMonth} ${existing.item.sku}`, oldValue: JSON.stringify(payload), payload: { source: input.source, ...payload }, actor, source: "reports" })),
  ] as never);
}

export async function deleteReportSalesRecord(db: Database, input: ReportSalesRecordDeleteInput, actor: ReportManualActor): Promise<void> {
  const scopeId = input.scopeId.trim();
  const reportMonth = input.reportMonth.trim();
  const sku = normalizeExternalSku(input.sku);
  if (!scopeId || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth) || !sku) throw new ReportManualError("invalid", "商品銷售紀錄的據點、月份或 SKU 不正確。");
  return deleteTargetSalesRecord(db, { ...input, scopeId, reportMonth, sku }, actor);
}

export async function deleteReportSalesRecords(db: Database, inputs: readonly ReportSalesRecordDeleteInput[], actor: ReportManualActor): Promise<number> {
  if (!inputs.length) throw new ReportManualError("invalid", "至少要選取一筆商品銷售紀錄。");
  const unique = new Map<string, ReportSalesRecordDeleteInput>();
  for (const input of inputs) {
    const normalized = { ...input, id: input.id.trim(), scopeId: input.scopeId.trim(), reportMonth: input.reportMonth.trim(), sku: normalizeExternalSku(input.sku) };
    if (!normalized.id || !normalized.scopeId || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(normalized.reportMonth) || !normalized.sku) throw new ReportManualError("invalid", "商品銷售紀錄的據點、月份、SKU 或 ID 不正確。");
    const key = normalized.source === "manual" ? `manual:${normalized.id}` : `imported:${normalized.scopeId}:${normalized.reportMonth}:${normalized.sku}`;
    if (!unique.has(key)) unique.set(key, normalized);
  }
  for (const input of unique.values()) await deleteReportSalesRecord(db, input, actor);
  return unique.size;
}
