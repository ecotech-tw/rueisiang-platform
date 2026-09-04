import { and, asc, desc, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { formatCyberbizProductName } from "./cyberbiz-product-name.js";
import { isCompanyReportStoreScopeId, isValidReportDate, normalizeReportScopeName } from "./report-data.js";
import { activityEvents } from "./schema/activity.js";
import {
  reportItemSalesMonthly,
  reportManualPayoutDaily,
  reportManualSalesMonthly,
  reportPayoutDaily,
  reportSalesMonthly,
  reportScopes,
  targetReportPayoutDaily,
  type ReportManualPayoutDaily,
  type ReportManualSalesMonthly,
  type ReportManualSkuSource,
  type ReportPayoutDaily,
  type ReportSalesMonthly,
} from "./schema/reports.js";
import { itemCategories, items as itemMasters } from "./schema/items.js";
import {
  cyberbizProductCategories,
  cyberbizProducts,
} from "./schema/wms.js";
import { reportProductCategories } from "./schema/report-products.js";
import { normalizeExternalSku } from "./product-sku-mappings.js";

async function hasTable(db: Database, name: string): Promise<boolean> {
  const row = await db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name} LIMIT 1`);
  return Boolean(row);
}

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
  categoryId?: string | null;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  actor: ReportManualActor;
}

export type ReportManualPayoutRow = any;
export type ReportManualSalesRow = any;
export type ReportManualRecordSource = "imported" | "manual";

/*
 * 篩選條件與分頁排序分開定義：總筆數只跟篩選條件有關，翻頁與換排序不會改變它。
 * 分開之後上層才能用不同的快取 key，換一次排序不必重數一遍。
 */
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

export interface ReportPayoutListPage {
  rows: ReportPayoutRecord[];
  page: number;
  pageSize: number;
}

export interface ReportSalesListPage {
  rows: ReportSalesRecord[];
  page: number;
  pageSize: number;
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
  // 停用據點仍有歷史報表需要修訂；新增據點的入口只會提供啟用中的選項。
  const [scope] = await db.select({ id: reportScopes.id, name: reportScopes.name })
    .from(reportScopes)
    .where(and(
      eq(reportScopes.id, id),
      eq(reportScopes.scopeKind, "store"),
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
      ...getTableColumns(cyberbizProducts),
      categoryName: reportProductCategories.name,
    })
      .from(cyberbizProducts)
      .leftJoin(cyberbizProductCategories, eq(cyberbizProductCategories.sku, cyberbizProducts.sku))
      .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
      .where(eq(cyberbizProducts.sku, sku))
      .limit(1);
    if (!product) throw new ReportManualError("not_found", `找不到 CYBERBIZ SKU「${sku}」。`);
    productName = formatCyberbizProductName(product);
    category = product.categoryName ?? "未分類";
  } else {
    if (input.categoryId !== undefined) {
      const categoryId = input.categoryId?.trim() ?? "";
      if (categoryId) {
        const [selectedCategory] = await db.select({ name: reportProductCategories.name })
          .from(reportProductCategories)
          .where(eq(reportProductCategories.id, categoryId))
          .limit(1);
        if (!selectedCategory) throw new ReportManualError("not_found", "找不到指定商品分類。");
        category = selectedCategory.name;
      } else {
        category = "未分類";
      }
    }
    if (!productName) throw new ReportManualError("invalid", "自訂 SKU 必須填寫商品名稱。");
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

function payoutPayload(row: any) {
  return {
    reportKind: "payout",
    scopeId: row.scopeId,
    businessDate: row.businessDate,
    payoutAmount: row.payoutAmount,
  };
}

function salesPayload(row: any) {
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

async function findTargetManualPayout(db: Database, id: string) {
  const [row] = await db.select().from(targetReportPayoutDaily)
    .where(and(
      eq(targetReportPayoutDaily.recordOrigin, "manual"),
      sql`'target:' || ${targetReportPayoutDaily.scopeId} || ':' || ${targetReportPayoutDaily.businessDate} = ${id}`,
    )).limit(1);
  return row ?? null;
}

async function findTargetManualSales(db: Database, id: string) {
  const rows = await db.select({ sales: reportItemSalesMonthly, item: itemMasters })
    .from(reportItemSalesMonthly)
    .innerJoin(itemMasters, eq(itemMasters.id, reportItemSalesMonthly.itemId))
    .where(eq(reportItemSalesMonthly.recordOrigin, "manual"));
  return rows.find(({ sales }) => targetSalesRecordId(sales.scopeId, sales.reportMonth, sales.itemId) === id) ?? null;
}

async function ensureTargetSalesItem(db: Database, prepared: Awaited<ReturnType<typeof prepareSales>>, now: string) {
  const [existing] = await db.select({ id: itemMasters.id }).from(itemMasters)
    .where(and(eq(itemMasters.source, prepared.skuSource), eq(itemMasters.sku, prepared.sku))).limit(1);
  if (existing) return existing;
  const [category] = prepared.category && prepared.category !== "未分類"
    ? await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, prepared.category)).limit(1)
    : [];
  const id = crypto.randomUUID();
  await db.insert(itemMasters).values({
    id,
    source: prepared.skuSource,
    kind: "sellable",
    sku: prepared.sku,
    name: prepared.productName,
    categoryId: category?.id ?? null,
    active: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

function targetSalesRecord(row: { sales: typeof reportItemSalesMonthly.$inferSelect; item: typeof itemMasters.$inferSelect }, scopeName: string, category = "未分類"): ReportSalesRecord {
  return {
    id: targetSalesRecordId(row.sales.scopeId, row.sales.reportMonth, row.sales.itemId),
    source: "manual",
    scopeId: row.sales.scopeId,
    scopeName,
    reportMonth: row.sales.reportMonth,
    skuSource: row.item.source === "custom" || row.item.source === "cyberbiz" ? row.item.source : null,
    sku: row.item.sku,
    productName: row.item.name,
    category,
    grossQuantity: row.sales.grossQuantity,
    returnQuantity: row.sales.returnQuantity,
    netQuantity: row.sales.netQuantity,
    salesAmount: row.sales.salesAmount,
    updatedByEmail: row.sales.updatedByEmail || "系統匯入",
    updatedAt: row.sales.updatedAt,
  };
}

/*
 * 人工修訂頁讀的是「目前有效值」，不是只讀人工表：
 * - 同一 key 有人工資料時，排除匯入資料。
 * - 沒有人工資料時，保留匯入資料，讓它可以被編輯成人工覆寫。
 * - source/id 讓前端知道編輯時要建立覆寫，刪除時只能刪人工覆寫。
 */
const PAYOUT_RECORD_SOURCE = sql`(
  SELECT
    target.record_origin AS source,
    CASE WHEN target.record_origin = 'manual' THEN 'target:' || target.scope_id || ':' || target.business_date ELSE 'imported:' || target.scope_id || ':' || target.business_date END AS id,
    target.scope_id, target.business_date, target.payout_amount,
    CASE WHEN target.record_origin = 'manual' THEN target.updated_by_email ELSE '系統匯入' END AS updated_by_email,
    target.updated_at
  FROM report_payout_daily_target AS target
  WHERE target.record_origin = 'manual'
    OR NOT EXISTS (SELECT 1 FROM report_manual_payout_daily AS manual WHERE manual.scope_id = target.scope_id AND manual.business_date = target.business_date)
  UNION ALL
  SELECT
    'imported' AS source,
    'imported:' || imported.scope_id || ':' || imported.business_date AS id,
    imported.scope_id, imported.business_date, imported.payout_amount,
    '系統匯入' AS updated_by_email, imported.updated_at
  FROM report_payout_daily AS imported
  WHERE NOT EXISTS (SELECT 1 FROM report_payout_daily_target AS target WHERE target.scope_id = imported.scope_id AND target.business_date = imported.business_date)
    AND NOT EXISTS (SELECT 1 FROM report_manual_payout_daily AS manual WHERE manual.scope_id = imported.scope_id AND manual.business_date = imported.business_date)
  UNION ALL
  SELECT
    'manual' AS source, manual.id, manual.scope_id, manual.business_date, manual.payout_amount,
    manual.updated_by_email, manual.updated_at
  FROM report_manual_payout_daily AS manual
  WHERE NOT EXISTS (SELECT 1 FROM report_payout_daily_target AS target WHERE target.scope_id = manual.scope_id AND target.business_date = manual.business_date)
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

const TARGET_PAYOUT_RECORD_SOURCE = sql`(
  SELECT
    'imported' AS source,
    'target:' || imported.scope_id || ':' || imported.business_date AS id,
    imported.scope_id,
    imported.business_date,
    imported.payout_amount,
    '系統匯入' AS updated_by_email,
    imported.updated_at
  FROM report_payout_daily_target AS imported
  WHERE imported.record_origin = 'imported'
    AND NOT EXISTS (
      SELECT 1 FROM report_payout_daily_target AS manual
      WHERE manual.scope_id = imported.scope_id
        AND manual.business_date = imported.business_date
        AND manual.record_origin = 'manual'
    )
  UNION ALL
  SELECT
    'manual' AS source,
    'target:' || manual.scope_id || ':' || manual.business_date AS id,
    manual.scope_id,
    manual.business_date,
    manual.payout_amount,
    manual.updated_by_email,
    manual.updated_at
  FROM report_payout_daily_target AS manual
  WHERE manual.record_origin = 'manual'
) AS report_payout_records`;

const TARGET_SALES_RECORD_SOURCE = sql`(
  SELECT
    'imported' AS source,
    'target:' || imported.scope_id || ':' || imported.report_month || ':' || imported.item_id AS id,
    imported.scope_id,
    imported.report_month,
    item.source AS sku_source,
    item.sku,
    item.name AS product_name,
    COALESCE(category.name, '未分類') AS category,
    imported.gross_quantity,
    imported.return_quantity,
    imported.net_quantity,
    imported.sales_amount,
    '系統匯入' AS updated_by_email,
    imported.updated_at
  FROM report_item_sales_monthly AS imported
  JOIN items AS item ON item.id = imported.item_id
  LEFT JOIN item_categories AS category ON category.id = item.category_id
  WHERE imported.record_origin = 'imported'
    AND NOT EXISTS (
      SELECT 1 FROM report_item_sales_monthly AS manual
      WHERE manual.scope_id = imported.scope_id
        AND manual.report_month = imported.report_month
        AND manual.item_id = imported.item_id
        AND manual.record_origin = 'manual'
    )
  UNION ALL
  SELECT
    'manual' AS source,
    'target:' || manual.scope_id || ':' || manual.report_month || ':' || manual.item_id AS id,
    manual.scope_id,
    manual.report_month,
    item.source AS sku_source,
    item.sku,
    item.name AS product_name,
    COALESCE(category.name, '未分類') AS category,
    manual.gross_quantity,
    manual.return_quantity,
    manual.net_quantity,
    manual.sales_amount,
    manual.updated_by_email,
    manual.updated_at
  FROM report_item_sales_monthly AS manual
  JOIN items AS item ON item.id = manual.item_id
  LEFT JOIN item_categories AS category ON category.id = item.category_id
  WHERE manual.record_origin = 'manual'
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

/*
 * 篩選條件與 FROM 子句抽出來共用：筆數與當頁資料是同一組條件的兩種問法，
 * 兩邊各寫一次遲早會漂移。分成兩個函式是為了讓上層能各自快取——筆數只跟
 * 篩選條件有關，翻頁與換排序都不該讓它重算。
 */
function payoutRecordScope(query: ReportPayoutFilters, source = PAYOUT_RECORD_SOURCE) {
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
  return {
    where: sql.join(conditions, sql` AND `),
    from: sql`FROM ${source}
    LEFT JOIN scopes AS report_scopes ON report_scopes.id = report_payout_records.scope_id`,
  };
}

export async function countReportPayoutRecords(db: Database, query: ReportPayoutFilters): Promise<number> {
  const source = await hasTable(db, "report_payout_daily") ? PAYOUT_RECORD_SOURCE : TARGET_PAYOUT_RECORD_SOURCE;
  const { where, from } = payoutRecordScope(query, source);
  const rows = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count ${from} WHERE ${where}`);
  return numberValue(rows[0]?.count);
}

export async function listReportPayoutRecords(
  db: Database,
  query: ReportPayoutListQuery,
): Promise<ReportPayoutListPage> {
  const source = await hasTable(db, "report_payout_daily") ? PAYOUT_RECORD_SOURCE : TARGET_PAYOUT_RECORD_SOURCE;
  const { where, from } = payoutRecordScope(query, source);
  const sortColumns = {
    scope: "COALESCE(report_scopes.name, report_payout_records.scope_id)",
    businessDate: "report_payout_records.business_date",
    payoutAmount: "report_payout_records.payout_amount",
    updatedAt: "report_payout_records.updated_at",
  } as const;
  const sortColumn = sortColumns[query.sortField] ?? sortColumns.businessDate;
  const direction = query.sortDirection === "asc" ? "ASC" : "DESC";
  const { limit, offset } = listLimit(query);
  const rows = await db.all<Record<string, unknown>>(sql`SELECT
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
      LIMIT ${limit} OFFSET ${offset}`);
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
  };
}

function salesRecordScope(query: ReportSalesFilters, source = SALES_RECORD_SOURCE) {
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
  return {
    where: sql.join(conditions, sql` AND `),
    from: sql`FROM ${source}
    LEFT JOIN scopes AS report_scopes ON report_scopes.id = report_sales_records.scope_id`,
  };
}

export async function countReportSalesRecords(db: Database, query: ReportSalesFilters): Promise<number> {
  const source = await hasTable(db, "report_sales_monthly") ? SALES_RECORD_SOURCE : TARGET_SALES_RECORD_SOURCE;
  const { where, from } = salesRecordScope(query, source);
  const rows = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count ${from} WHERE ${where}`);
  return numberValue(rows[0]?.count);
}

export async function listReportSalesRecords(
  db: Database,
  query: ReportSalesListQuery,
): Promise<ReportSalesListPage> {
  const source = await hasTable(db, "report_sales_monthly") ? SALES_RECORD_SOURCE : TARGET_SALES_RECORD_SOURCE;
  const { where, from } = salesRecordScope(query, source);
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
  const rows = await db.all<Record<string, unknown>>(sql`SELECT
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
      LIMIT ${limit} OFFSET ${offset}`);
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
  };
}

export async function listReportManualPayouts(db: Database): Promise<ReportManualPayoutRow[]> {
  if (!await hasTable(db, "report_manual_payout_daily")) {
    const names = await scopeNames(db);
    const rows = await db.select().from(targetReportPayoutDaily)
      .where(eq(targetReportPayoutDaily.recordOrigin, "manual"))
      .orderBy(asc(targetReportPayoutDaily.businessDate), asc(targetReportPayoutDaily.scopeId));
    return rows.map((row) => ({
      id: targetPayoutRecordId(row.scopeId, row.businessDate),
      source: "manual",
      scopeId: row.scopeId,
      scopeName: names.get(row.scopeId) ?? row.scopeId,
      businessDate: row.businessDate,
      payoutAmount: row.payoutAmount,
      updatedByEmail: row.updatedByEmail,
      updatedAt: row.updatedAt,
    }));
  }
  const [rows, names] = await Promise.all([
    db.select().from(reportManualPayoutDaily)
      .orderBy(asc(reportManualPayoutDaily.businessDate), asc(reportManualPayoutDaily.id)),
    scopeNames(db),
  ]);
  return rows.map((row) => ({ ...row, scopeName: names.get(row.scopeId) ?? row.scopeId }));
}

export async function listReportManualSales(db: Database): Promise<ReportManualSalesRow[]> {
  if (!await hasTable(db, "report_manual_sales_monthly")) {
    const names = await scopeNames(db);
    const [rows, categories] = await Promise.all([
      db.select({ sales: reportItemSalesMonthly, item: itemMasters }).from(reportItemSalesMonthly).innerJoin(itemMasters, eq(itemMasters.id, reportItemSalesMonthly.itemId)).where(eq(reportItemSalesMonthly.recordOrigin, "manual")).orderBy(asc(reportItemSalesMonthly.reportMonth), asc(itemMasters.sku), asc(reportItemSalesMonthly.itemId)),
      db.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories),
    ]);
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    return rows.map((row) => targetSalesRecord(row, names.get(row.sales.scopeId) ?? row.sales.scopeId, categoryNames.get(row.item.categoryId ?? "") ?? "未分類"));
  }
  const [rows, names] = await Promise.all([
    db.select().from(reportManualSalesMonthly)
      .orderBy(asc(reportManualSalesMonthly.reportMonth), asc(reportManualSalesMonthly.sku), asc(reportManualSalesMonthly.id)),
    scopeNames(db),
  ]);
  return rows.map((row) => ({ ...row, scopeName: names.get(row.scopeId) ?? row.scopeId }));
}

async function createTargetManualPayout(db: Database, input: ReportManualPayoutInput): Promise<ReportManualPayoutRow> {
  const prepared = await preparePayout(db, input);
  const [existing] = await db.select().from(targetReportPayoutDaily).where(and(
    eq(targetReportPayoutDaily.scopeId, prepared.scopeId),
    eq(targetReportPayoutDaily.businessDate, prepared.businessDate),
    eq(targetReportPayoutDaily.recordOrigin, "manual"),
  )).limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點在這個日期已經有人工出金資料，請改用編輯。");
  const id = targetPayoutRecordId(prepared.scopeId, prepared.businessDate);
  const now = new Date().toISOString();
  await db.batch([
    db.insert(targetReportPayoutDaily).values({ scopeId: prepared.scopeId, businessDate: prepared.businessDate, recordOrigin: "manual", reportRunId: null, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, createdAt: now, updatedAt: now }),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate), eventType: "report_manual_payout_created", summary: `新增人工出金資料：${prepared.scope.name} ${prepared.businessDate}`, field: "payoutAmount", newValue: String(prepared.payoutAmount), payload: payoutPayload(prepared), actor: input.actor, source: "reports" })),
  ] as never);
  return { id, source: "manual", scopeId: prepared.scopeId, scopeName: prepared.scope.name, businessDate: prepared.businessDate, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, updatedAt: now };
}

export async function createReportManualPayout(
  db: Database,
  input: ReportManualPayoutInput,
): Promise<ReportManualPayoutRow> {
  if (!await hasTable(db, "report_manual_payout_daily")) return createTargetManualPayout(db, input);
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
    db.insert(targetReportPayoutDaily).values({ scopeId: prepared.scopeId, businessDate: prepared.businessDate, recordOrigin: "manual", reportRunId: null, payoutAmount: prepared.payoutAmount, updatedByEmail: input.actor.email, createdAt: now, updatedAt: now }),
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

async function updateTargetManualPayout(db: Database, input: ReportManualPayoutInput & { id: string }): Promise<ReportManualPayoutRow> {
  const existing = await findTargetManualPayout(db, input.id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const prepared = await preparePayout(db, input);
  const [conflict] = await db.select({ scopeId: targetReportPayoutDaily.scopeId }).from(targetReportPayoutDaily).where(and(
    eq(targetReportPayoutDaily.scopeId, prepared.scopeId),
    eq(targetReportPayoutDaily.businessDate, prepared.businessDate),
    eq(targetReportPayoutDaily.recordOrigin, "manual"),
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

export async function updateReportManualPayout(
  db: Database,
  input: ReportManualPayoutInput & { id: string },
): Promise<ReportManualPayoutRow> {
  if (!await hasTable(db, "report_manual_payout_daily")) return updateTargetManualPayout(db, input);
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
    db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.recordOrigin, "manual"), eq(targetReportPayoutDaily.scopeId, existing.scopeId), eq(targetReportPayoutDaily.businessDate, existing.businessDate))),
    db.insert(targetReportPayoutDaily).values({ scopeId: next.scopeId, businessDate: next.businessDate, recordOrigin: "manual", reportRunId: null, payoutAmount: next.payoutAmount, updatedByEmail: next.updatedByEmail, updatedAt }).onConflictDoUpdate({ target: [targetReportPayoutDaily.scopeId, targetReportPayoutDaily.businessDate, targetReportPayoutDaily.recordOrigin], set: { payoutAmount: next.payoutAmount, updatedByEmail: next.updatedByEmail, updatedAt } }),
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

async function deleteTargetManualPayout(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const existing = await findTargetManualPayout(db, id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, existing.scopeId), eq(targetReportPayoutDaily.businessDate, existing.businessDate), eq(targetReportPayoutDaily.recordOrigin, "manual"))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: payoutLabel(scopeName, existing.businessDate), eventType: "report_manual_payout_deleted", summary: `刪除人工出金資料：${scopeName} ${existing.businessDate}`, field: "payoutAmount", oldValue: String(existing.payoutAmount), payload: payoutPayload(existing), actor, source: "reports" })),
  ] as never);
}

export async function deleteReportManualPayout(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  if (!await hasTable(db, "report_manual_payout_daily")) return deleteTargetManualPayout(db, id, actor);
  const [existing] = await db.select().from(reportManualPayoutDaily)
    .where(eq(reportManualPayoutDaily.id, id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, id)),
    db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.recordOrigin, "manual"), eq(targetReportPayoutDaily.scopeId, existing.scopeId), eq(targetReportPayoutDaily.businessDate, existing.businessDate))),
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

/** 刪除頁面目前看到的出金紀錄；刪除人工覆寫後讓同 key 的匯入值自然恢復。 */
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

  if (!await hasTable(db, "report_manual_payout_daily")) {
    const [existing] = await db.select().from(targetReportPayoutDaily).where(and(
      eq(targetReportPayoutDaily.scopeId, scopeId),
      eq(targetReportPayoutDaily.businessDate, businessDate),
      eq(targetReportPayoutDaily.recordOrigin, input.source === "imported" ? "imported" : "manual"),
    )).limit(1);
    if (!existing) throw new ReportManualError("not_found", "找不到這筆出金紀錄。");
    const names = await scopeNames(db);
    const scopeName = names.get(scopeId) ?? scopeId;
    await db.batch([
      db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, scopeId), eq(targetReportPayoutDaily.businessDate, businessDate), eq(targetReportPayoutDaily.recordOrigin, existing.recordOrigin))),
      db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: payoutLabel(scopeName, businessDate), eventType: "report_payout_record_deleted", summary: `刪除出金資料：${scopeName} ${businessDate}`, field: "payoutAmount", oldValue: String(existing.payoutAmount), payload: { source: input.source, ...payoutPayload(existing) }, actor, source: "reports" })),
    ] as never);
    return;
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
  const [targetImported] = input.source === "imported"
    ? await db.select().from(targetReportPayoutDaily).where(and(
      eq(targetReportPayoutDaily.scopeId, scopeId),
      eq(targetReportPayoutDaily.businessDate, businessDate),
      eq(targetReportPayoutDaily.recordOrigin, "imported"),
    )).limit(1)
    : [];
  const existing = manual ?? imported ?? targetImported;
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
    input.source === "imported"
      ? db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, scopeId), eq(targetReportPayoutDaily.businessDate, businessDate), eq(targetReportPayoutDaily.recordOrigin, "imported")))
      : db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, scopeId), eq(targetReportPayoutDaily.businessDate, businessDate), eq(targetReportPayoutDaily.recordOrigin, "manual"))),
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

export async function deleteReportPayoutRecords(
  db: Database,
  inputs: readonly ReportPayoutRecordDeleteInput[],
  actor: ReportManualActor,
): Promise<number> {
  if (!inputs.length) throw new ReportManualError("invalid", "至少要選取一筆出金紀錄。");

  if (!await hasTable(db, "report_manual_payout_daily")) {
    const unique = new Map<string, ReportPayoutRecordDeleteInput>();
    for (const input of inputs) {
      const scopeId = input.scopeId.trim();
      const businessDate = input.businessDate.trim();
      if (!input.id.trim() || !scopeId || !isValidReportDate(businessDate)) throw new ReportManualError("invalid", "出金紀錄的據點、日期或 ID 不正確。");
      const key = `${input.source}:${scopeId}:${businessDate}`;
      if (!unique.has(key)) unique.set(key, { ...input, id: input.id.trim(), scopeId, businessDate });
    }
    for (const input of unique.values()) await deleteReportPayoutRecord(db, input, actor);
    return unique.size;
  }

  const unique = new Map<string, ReportPayoutRecordDeleteInput>();
  for (const input of inputs) {
    const scopeId = input.scopeId.trim();
    const businessDate = input.businessDate.trim();
    const id = input.id.trim();
    if (!id || !scopeId || !isValidReportDate(businessDate)) {
      throw new ReportManualError("invalid", "出金紀錄的據點、日期或 ID 不正確。");
    }
    const key = input.source === "manual" ? `manual:${id}` : `imported:${scopeId}:${businessDate}`;
    if (!unique.has(key)) unique.set(key, { ...input, id, scopeId, businessDate });
  }

  const entries: Array<{
    input: ReportPayoutRecordDeleteInput;
    existing: ReportManualPayoutDaily | ReportPayoutDaily | typeof targetReportPayoutDaily.$inferSelect;
  }> = [];
  for (const input of unique.values()) {
    const [manual] = input.source === "manual"
      ? await db.select().from(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, input.id)).limit(1)
      : [];
    const [imported] = input.source === "imported"
      ? await db.select().from(reportPayoutDaily).where(and(
        eq(reportPayoutDaily.scopeId, input.scopeId),
        eq(reportPayoutDaily.businessDate, input.businessDate),
      )).limit(1)
      : [];
    const [targetImported] = input.source === "imported"
      ? await db.select().from(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, input.scopeId), eq(targetReportPayoutDaily.businessDate, input.businessDate), eq(targetReportPayoutDaily.recordOrigin, "imported"))).limit(1)
      : [];
    const existing = manual ?? imported ?? targetImported;
    if (!existing) throw new ReportManualError("not_found", "找不到選取的出金紀錄。");
    entries.push({ input, existing });
  }

  const names = await scopeNames(db);
  type Statement = Parameters<Database["batch"]>[0][number];
  const statements: Statement[] = [];
  for (const { input, existing } of entries) {
    const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
    const entityId = input.source === "manual" ? input.id : `imported:${input.scopeId}:${input.businessDate}`;
    statements.push(
      input.source === "manual"
        ? db.delete(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, input.id))
        : db.delete(reportPayoutDaily).where(and(
          eq(reportPayoutDaily.scopeId, input.scopeId),
          eq(reportPayoutDaily.businessDate, input.businessDate),
        )),
      db.delete(targetReportPayoutDaily).where(and(eq(targetReportPayoutDaily.scopeId, input.scopeId), eq(targetReportPayoutDaily.businessDate, input.businessDate), eq(targetReportPayoutDaily.recordOrigin, input.source === "imported" ? "imported" : "manual"))),
      db.insert(activityEvents).values(activityRow({
        entityType: "report_manual_entry",
        entityId,
        entityLabel: payoutLabel(scopeName, existing.businessDate),
        eventType: "report_payout_record_deleted",
        summary: `刪除出金資料：${scopeName} ${existing.businessDate}`,
        field: "payoutAmount",
        oldValue: String(existing.payoutAmount),
        payload: { source: input.source, ...payoutPayload(existing) },
        actor,
        source: "reports",
      })),
    );
  }
  for (let start = 0; start < statements.length; start += 50) {
    const batch = statements.slice(start, start + 50);
    await db.batch(batch as [Statement, ...Statement[]]);
  }
  return entries.length;
}

async function createTargetManualSales(db: Database, input: ReportManualSalesInput): Promise<ReportManualSalesRow> {
  const prepared = await prepareSales(db, input);
  const now = new Date().toISOString();
  const matchedItem = await ensureTargetSalesItem(db, prepared, now);
  const [existing] = await db.select({ itemId: reportItemSalesMonthly.itemId }).from(reportItemSalesMonthly).where(and(
    eq(reportItemSalesMonthly.scopeId, prepared.scopeId),
    eq(reportItemSalesMonthly.reportMonth, prepared.reportMonth),
    eq(reportItemSalesMonthly.itemId, matchedItem.id),
    eq(reportItemSalesMonthly.recordOrigin, "manual"),
  )).limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有人工商品銷售資料，請改用編輯。");
  const row = { scopeId: prepared.scopeId, reportMonth: prepared.reportMonth, itemId: matchedItem.id, recordOrigin: "manual" as const, reportRunId: null, grossQuantity: prepared.grossQuantity, returnQuantity: prepared.returnQuantity, netQuantity: prepared.netQuantity, salesAmount: prepared.salesAmount, updatedByEmail: input.actor.email, createdAt: now, updatedAt: now };
  const id = targetSalesRecordId(row.scopeId, row.reportMonth, row.itemId);
  await db.batch([
    db.insert(reportItemSalesMonthly).values(row),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku), eventType: "report_manual_sales_created", summary: `新增人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`, payload: salesPayload(prepared), actor: input.actor, source: "reports" })),
  ] as never);
  return targetSalesRecord({ sales: row, item: { ...matchedItem, source: prepared.skuSource, sku: prepared.sku, name: prepared.productName } as typeof itemMasters.$inferSelect }, prepared.scope.name, prepared.category);
}

export async function createReportManualSales(
  db: Database,
  input: ReportManualSalesInput,
): Promise<ReportManualSalesRow> {
  if (!await hasTable(db, "report_manual_sales_monthly")) return createTargetManualSales(db, input);
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
  let [matchedItem] = await db
    .select({ id: itemMasters.id })
    .from(itemMasters)
    .where(and(eq(itemMasters.source, prepared.skuSource), eq(itemMasters.sku, prepared.sku)))
    .limit(1);
  if (!matchedItem) {
    const newItemId = crypto.randomUUID();
    let categoryId: string | null = null;
    if (prepared.category && prepared.category !== "未分類") {
      const [cat] = await db
        .select({ id: itemCategories.id })
        .from(itemCategories)
        .where(eq(itemCategories.name, prepared.category))
        .limit(1);
      categoryId = cat?.id ?? null;
    }
    await db
      .insert(itemMasters)
      .values({
        id: newItemId,
        source: prepared.skuSource,
        kind: "sellable",
        sku: prepared.sku,
        name: prepared.productName,
        categoryId,
        active: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    matchedItem = { id: newItemId };
  }

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
    db
      .insert(reportItemSalesMonthly)
      .values({
        scopeId: prepared.scopeId,
        reportMonth: prepared.reportMonth,
        itemId: matchedItem.id,
        recordOrigin: "manual",
        reportRunId: null,
        grossQuantity: prepared.grossQuantity,
        returnQuantity: prepared.returnQuantity,
        netQuantity: prepared.netQuantity,
        salesAmount: prepared.salesAmount,
        updatedByEmail: input.actor.email,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          reportItemSalesMonthly.scopeId,
          reportItemSalesMonthly.reportMonth,
          reportItemSalesMonthly.itemId,
          reportItemSalesMonthly.recordOrigin,
        ],
        set: {
          grossQuantity: prepared.grossQuantity,
          returnQuantity: prepared.returnQuantity,
          netQuantity: prepared.netQuantity,
          salesAmount: prepared.salesAmount,
          updatedByEmail: input.actor.email,
          updatedAt: now,
        },
      }),
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

async function updateTargetManualSales(db: Database, input: ReportManualSalesInput & { id: string }): Promise<ReportManualSalesRow> {
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
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku), eventType: "report_manual_sales_updated", summary: `更新人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`, payload: { before: salesPayload(existing.sales), after: salesPayload(prepared) }, actor: input.actor, source: "reports" })),
  ] as never);
  return targetSalesRecord({ sales: { ...next, createdAt: existing.sales.createdAt }, item: { ...matchedItem, source: prepared.skuSource, sku: prepared.sku, name: prepared.productName } as typeof itemMasters.$inferSelect }, prepared.scope.name, prepared.category);
}

export async function updateReportManualSales(
  db: Database,
  input: ReportManualSalesInput & { id: string },
): Promise<ReportManualSalesRow> {
  if (!await hasTable(db, "report_manual_sales_monthly")) return updateTargetManualSales(db, input);
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
  let [matchedItem] = await db
    .select({ id: itemMasters.id })
    .from(itemMasters)
    .where(and(eq(itemMasters.source, prepared.skuSource), eq(itemMasters.sku, prepared.sku)))
    .limit(1);
  if (!matchedItem) {
    const newItemId = crypto.randomUUID();
    let categoryId: string | null = null;
    if (prepared.category && prepared.category !== "未分類") {
      const [cat] = await db
        .select({ id: itemCategories.id })
        .from(itemCategories)
        .where(eq(itemCategories.name, prepared.category))
        .limit(1);
      categoryId = cat?.id ?? null;
    }
    await db
      .insert(itemMasters)
      .values({
        id: newItemId,
        source: prepared.skuSource,
        kind: "sellable",
        sku: prepared.sku,
        name: prepared.productName,
        categoryId,
        active: 1,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoNothing();
    matchedItem = { id: newItemId };
  }

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
    db.delete(reportItemSalesMonthly).where(and(
      eq(reportItemSalesMonthly.scopeId, existing.scopeId),
      eq(reportItemSalesMonthly.reportMonth, existing.reportMonth),
      eq(reportItemSalesMonthly.recordOrigin, "manual"),
      sql`${reportItemSalesMonthly.itemId} IN (SELECT id FROM items WHERE source = ${existing.skuSource} AND lower(sku) = lower(${existing.sku}))`,
    )),
    db
      .insert(reportItemSalesMonthly)
      .values({
        scopeId: prepared.scopeId,
        reportMonth: prepared.reportMonth,
        itemId: matchedItem.id,
        recordOrigin: "manual",
        reportRunId: null,
        grossQuantity: prepared.grossQuantity,
        returnQuantity: prepared.returnQuantity,
        netQuantity: prepared.netQuantity,
        salesAmount: prepared.salesAmount,
        updatedByEmail: input.actor.email,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          reportItemSalesMonthly.scopeId,
          reportItemSalesMonthly.reportMonth,
          reportItemSalesMonthly.itemId,
          reportItemSalesMonthly.recordOrigin,
        ],
        set: {
          grossQuantity: prepared.grossQuantity,
          returnQuantity: prepared.returnQuantity,
          netQuantity: prepared.netQuantity,
          salesAmount: prepared.salesAmount,
          updatedByEmail: input.actor.email,
          updatedAt,
        },
      }),
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

async function deleteTargetManualSales(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const existing = await findTargetManualSales(db, id);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.sales.scopeId) ?? existing.sales.scopeId;
  await db.batch([
    db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, existing.sales.scopeId), eq(reportItemSalesMonthly.reportMonth, existing.sales.reportMonth), eq(reportItemSalesMonthly.itemId, existing.sales.itemId), eq(reportItemSalesMonthly.recordOrigin, "manual"))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: salesLabel(scopeName, existing.sales.reportMonth, existing.item.sku), eventType: "report_manual_sales_deleted", summary: `刪除人工商品銷售資料：${scopeName} ${existing.sales.reportMonth} ${existing.item.sku}`, payload: salesPayload({ ...existing.sales, skuSource: existing.item.source, sku: existing.item.sku, productName: existing.item.name, category: "未分類" }), actor, source: "reports" })),
  ] as never);
}

export async function deleteReportManualSales(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  if (!await hasTable(db, "report_manual_sales_monthly")) return deleteTargetManualSales(db, id, actor);
  const [existing] = await db.select().from(reportManualSalesMonthly)
    .where(eq(reportManualSalesMonthly.id, id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, id)),
    db.delete(reportItemSalesMonthly).where(and(
      eq(reportItemSalesMonthly.scopeId, existing.scopeId),
      eq(reportItemSalesMonthly.reportMonth, existing.reportMonth),
      eq(reportItemSalesMonthly.recordOrigin, "manual"),
      sql`${reportItemSalesMonthly.itemId} IN (SELECT id FROM items WHERE lower(sku) = lower(${existing.sku}))`,
    )),
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

export async function deleteReportSalesRecords(
  db: Database,
  inputs: readonly ReportSalesRecordDeleteInput[],
  actor: ReportManualActor,
): Promise<number> {
  if (!inputs.length) throw new ReportManualError("invalid", "至少要選取一筆商品銷售紀錄。");

  const unique = new Map<string, ReportSalesRecordDeleteInput>();
  for (const input of inputs) {
    const scopeId = input.scopeId.trim();
    const reportMonth = input.reportMonth.trim();
    const sku = normalizeExternalSku(input.sku);
    const id = input.id.trim();
    if (!id || !scopeId || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth) || !sku) {
      throw new ReportManualError("invalid", "商品銷售紀錄的據點、月份、SKU 或 ID 不正確。");
    }
    const key = input.source === "manual" ? `manual:${id}` : `imported:${scopeId}:${reportMonth}:${sku}`;
    if (!unique.has(key)) unique.set(key, { ...input, id, scopeId, reportMonth, sku });
  }

  if (!await hasTable(db, "report_manual_sales_monthly")) {
    for (const input of unique.values()) await deleteReportSalesRecord(db, input, actor);
    return unique.size;
  }

  const entries: Array<{
    input: ReportSalesRecordDeleteInput;
    existing: ReportManualSalesMonthly | ReportSalesMonthly;
    skuSource: ReportManualSkuSource | null;
  }> = [];
  for (const input of unique.values()) {
    const [manual] = input.source === "manual"
      ? await db.select().from(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, input.id)).limit(1)
      : [];
    const [imported] = input.source === "imported"
      ? await db.select().from(reportSalesMonthly).where(and(
        eq(reportSalesMonthly.scopeId, input.scopeId),
        eq(reportSalesMonthly.reportMonth, input.reportMonth),
        sql`lower(${reportSalesMonthly.sku}) = lower(${input.sku})`,
      )).limit(1)
      : [];
    const existing = manual ?? imported;
    if (!existing) throw new ReportManualError("not_found", "找不到選取的商品銷售紀錄。");
    entries.push({
      input,
      existing,
      skuSource: input.source === "manual" ? manual?.skuSource ?? null : null,
    });
  }

  const names = await scopeNames(db);
  type Statement = Parameters<Database["batch"]>[0][number];
  const statements: Statement[] = [];
  for (const { input, existing, skuSource } of entries) {
    const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
    const entityId = input.source === "manual"
      ? input.id
      : `imported:${existing.scopeId}:${existing.reportMonth}:${existing.sku}`;
    const deletedSalesPayload = salesPayload({ ...existing, skuSource });
    statements.push(
      input.source === "manual"
        ? db.delete(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, input.id))
        : db.delete(reportSalesMonthly).where(and(
          eq(reportSalesMonthly.scopeId, input.scopeId),
          eq(reportSalesMonthly.reportMonth, input.reportMonth),
          sql`lower(${reportSalesMonthly.sku}) = lower(${input.sku})`,
        )),
      db.delete(reportItemSalesMonthly).where(and(
        eq(reportItemSalesMonthly.scopeId, existing.scopeId),
        eq(reportItemSalesMonthly.reportMonth, existing.reportMonth),
        input.source === "manual" ? eq(reportItemSalesMonthly.recordOrigin, "manual") : eq(reportItemSalesMonthly.recordOrigin, "imported"),
        sql`${reportItemSalesMonthly.itemId} IN (SELECT id FROM items WHERE source = ${skuSource} AND lower(sku) = lower(${existing.sku}))`,
      )),
      db.insert(activityEvents).values(activityRow({
        entityType: "report_manual_entry",
        entityId,
        entityLabel: salesLabel(scopeName, existing.reportMonth, existing.sku),
        eventType: "report_sales_record_deleted",
        summary: `刪除商品銷售資料：${scopeName} ${existing.reportMonth} ${existing.sku}`,
        oldValue: JSON.stringify(deletedSalesPayload),
        payload: { source: input.source, ...deletedSalesPayload },
        actor,
        source: "reports",
      })),
    );
  }
  for (let start = 0; start < statements.length; start += 50) {
    const batch = statements.slice(start, start + 50);
    await db.batch(batch as [Statement, ...Statement[]]);
  }
  return entries.length;
}

async function deleteTargetSalesRecord(db: Database, input: ReportSalesRecordDeleteInput, actor: ReportManualActor): Promise<void> {
  const rows = await db.select({ sales: reportItemSalesMonthly, item: itemMasters })
    .from(reportItemSalesMonthly)
    .innerJoin(itemMasters, eq(itemMasters.id, reportItemSalesMonthly.itemId))
    .where(and(
      eq(reportItemSalesMonthly.scopeId, input.scopeId),
      eq(reportItemSalesMonthly.reportMonth, input.reportMonth),
      eq(reportItemSalesMonthly.recordOrigin, input.source === "manual" ? "manual" : "imported"),
    ));
  const existing = input.source === "manual"
    ? rows.find(({ sales }) => targetSalesRecordId(sales.scopeId, sales.reportMonth, sales.itemId) === input.id)
    : rows.find(({ item }) => item.sku.toLowerCase() === input.sku.toLowerCase());
  if (!existing) throw new ReportManualError("not_found", "找不到這筆商品銷售紀錄。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.sales.scopeId) ?? existing.sales.scopeId;
  const deletedSalesPayload = salesPayload({ ...existing.sales, skuSource: existing.item.source, sku: existing.item.sku, productName: existing.item.name, category: "未分類" });
  await db.batch([
    db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, existing.sales.scopeId), eq(reportItemSalesMonthly.reportMonth, existing.sales.reportMonth), eq(reportItemSalesMonthly.itemId, existing.sales.itemId), eq(reportItemSalesMonthly.recordOrigin, existing.sales.recordOrigin))),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: input.id, entityLabel: salesLabel(scopeName, existing.sales.reportMonth, existing.item.sku), eventType: "report_sales_record_deleted", summary: `刪除商品銷售資料：${scopeName} ${existing.sales.reportMonth} ${existing.item.sku}`, oldValue: JSON.stringify(deletedSalesPayload), payload: { source: input.source, ...deletedSalesPayload }, actor, source: "reports" })),
  ] as never);
}

/** 刪除頁面目前看到的商品銷售紀錄；刪除人工覆寫後讓同 key 的匯入值自然恢復。 */
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

  if (!await hasTable(db, "report_manual_sales_monthly")) {
    return deleteTargetSalesRecord(db, { ...input, scopeId, reportMonth, sku }, actor);
  }

  const [manual] = input.source === "manual"
    ? await db.select().from(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, input.id)).limit(1)
    : [];
  const [imported] = input.source === "imported"
    ? await db.select().from(reportSalesMonthly).where(and(
      eq(reportSalesMonthly.scopeId, scopeId),
      eq(reportSalesMonthly.reportMonth, reportMonth),
      sql`lower(${reportSalesMonthly.sku}) = lower(${sku})`,
    )).limit(1)
    : [];
  const existing = manual ?? imported;
  if (!existing) throw new ReportManualError("not_found", "找不到這筆商品銷售紀錄。");

  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  const entityId = input.source === "manual"
    ? input.id
    : `imported:${existing.scopeId}:${existing.reportMonth}:${existing.sku}`;
  const deletedSalesPayload = salesPayload({
    ...existing,
    skuSource: input.source === "manual" ? manual?.skuSource ?? null : null,
  });
  await db.batch([
    input.source === "manual"
      ? db.delete(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, input.id))
      : db.delete(reportSalesMonthly).where(and(
        eq(reportSalesMonthly.scopeId, scopeId),
        eq(reportSalesMonthly.reportMonth, reportMonth),
        sql`lower(${reportSalesMonthly.sku}) = lower(${sku})`,
      )),
    db.delete(reportItemSalesMonthly).where(and(
      eq(reportItemSalesMonthly.scopeId, scopeId),
      eq(reportItemSalesMonthly.reportMonth, reportMonth),
      input.source === "manual" ? eq(reportItemSalesMonthly.recordOrigin, "manual") : eq(reportItemSalesMonthly.recordOrigin, "imported"),
      sql`${reportItemSalesMonthly.itemId} IN (SELECT id FROM items WHERE lower(sku) = lower(${sku}))`,
    )),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId,
      entityLabel: salesLabel(scopeName, existing.reportMonth, existing.sku),
      eventType: "report_sales_record_deleted",
      summary: `刪除商品銷售資料：${scopeName} ${existing.reportMonth} ${existing.sku}`,
      oldValue: JSON.stringify(deletedSalesPayload),
      payload: { source: input.source, ...deletedSalesPayload },
      actor,
      source: "reports",
    })),
  ] as never);
}
