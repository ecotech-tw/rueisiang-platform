import { and, asc, eq, inArray, sql, sum } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  reportItemSalesMonthly,
  reportItemSalesPeriod,
  reportRuns,
  reportRunScopes,
  scopes as targetScopes,
  reportPayoutDaily,
  type ScopeKind,
} from "./schema/reports.js";
import { itemCategories, items as itemMasters } from "./schema/items.js";
import { dataChannelFromScopeId, shopeeBaseExternalSku } from "./product-sku-mappings.js";

/**
 * 查詢的維度：一個通路，還是全公司。**不是** scopes.scope_kind——那一欄是這個
 * 通路本身是什麼（store／channel／company），兩者剛好有兩個同名的值而已。
 */
export type ReportScopeKind = "store" | "company";
export type ReportManualSkuSource = "custom" | "cyberbiz";
export interface ReportScope {
  id: string;
  sourceType: string;
  scopeKind: ReportScopeKind;
  name: string;
  normalizedName: string;
  active: number;
  createdAt: string;
  updatedAt: string;
}

/** 匯入 driver 的平面資料；寫入時會由 SKU 解析成 target item_id。 */
export interface NewReportSalesMonthly {
  scopeId: string;
  reportMonth: string;
  sku: string;
  productName?: string;
  category?: string;
  grossQuantity: number;
  returnQuantity?: number;
  netQuantity: number;
  salesAmount: number;
}

export interface NewReportPayoutDaily {
  scopeId: string;
  businessDate: string;
  payoutAmount: number;
}

const REPORT_SALES_WRITE_BATCH_SIZE = 9;
const REPORT_PAYOUT_WRITE_BATCH_SIZE = 10;

/**
 * 舊版手動匯入沒有 run ID，但 target imported row 不能用 NULL 偽裝成歷史資料。
 * target-only DB 遇到這條入口時建立一筆可追查的 system import run，讓 FK 與 origin
 * 的語意都維持一致；自動 ingest 傳入的 run ID 則沿用原本的 run。
 */
async function ensureTargetImportRun(
  db: Database,
  input: {
    reportRunId?: string;
    sourceType: string;
    importsSales: boolean;
    importsPayout: boolean;
    scopeIds: readonly string[];
    startDate: string;
    endDate: string;
  },
): Promise<string | undefined> {
  if (input.reportRunId) return input.reportRunId;
  if (!input.scopeIds.length) return undefined;
  const id = crypto.randomUUID();
  const requestId = `target-import:${id}`;
  await db.batch([
    db.insert(reportRuns).values({
      id,
      requestId,
      sourceType: input.sourceType,
      importsSales: input.importsSales ? 1 : 0,
      importsPayout: input.importsPayout ? 1 : 0,
      periodKind: input.importsSales ? "month" : "custom",
      startDate: input.startDate,
      endDate: input.endDate,
      status: "succeeded",
      actorEmail: "system@target-import",
    }),
    ...[...new Set(input.scopeIds)].map((scopeId) => db.insert(reportRunScopes).values({ reportRunId: id, scopeId })),
  ] as never);
  return id;
}

async function ensureTargetSalesItems(
  db: Database,
  rows: readonly NewReportSalesMonthly[],
  createMissing: boolean,
): Promise<Map<string, string>> {
  const wanted = [...new Set(rows.map((row) => row.sku.trim().toLowerCase()).filter(Boolean))];
  const found = (await Promise.all(chunks(wanted, 50).map((batch) => db.all<{ id: string; source: string; sku: string }>(
    sql`SELECT id, source, sku FROM items WHERE lower(sku) IN (${sql.join(batch.map((sku) => sql`${sku}`), sql`, `)})`,
  )))).flat();
  const bySku = new Map<string, { id: string; source: string }>();
  for (const item of found) {
    const key = item.sku.toLowerCase();
    // target item 的 SKU 可能因不同來源重複；WMS／custom 解析結果優先於官網鏡像。
    const current = bySku.get(key);
    if (!current || (current.source === "cyberbiz" && item.source !== "cyberbiz")) bySku.set(key, { id: item.id, source: item.source });
  }

  const categoryNames = [...new Set(rows.map((row) => (row.category ?? "").trim()).filter((category) => category && category !== "未分類"))];
  const categories = (await Promise.all(chunks(categoryNames, 50).map((batch) => db.select({ id: itemCategories.id, name: itemCategories.name })
    .from(itemCategories)
    .where(inArray(itemCategories.name, batch))))).flat();
  const categoryByName = new Map(categories.map((category) => [category.name, category.id]));
  if (createMissing) for (const row of rows) {
    const sku = row.sku.trim();
    const key = sku.toLowerCase();
    if (!sku || bySku.has(key)) continue;
    const id = crypto.randomUUID();
    await db.insert(itemMasters).values({
      id,
      source: "custom",
      kind: "sellable",
      sku,
      name: (row.productName ?? "").trim() || sku,
      categoryId: categoryByName.get((row.category ?? "").trim()) ?? null,
      active: 1,
    });
    bySku.set(key, { id, source: "custom" });
  }
  return new Map([...bySku].map(([sku, item]) => [sku, item.id]));
}

export type ReportGroupBy = "day" | "month" | "scope" | "sku" | "category";

export interface ReportRange {
  period: string;
  startDate: string;
  endDate: string;
  /** HTTP 以 startDate/endDate 查詢時保留這個資訊，避免同月自訂區間被當成整月。 */
  isCustom?: boolean;
}

export interface ReportScopeInput {
  id: string;
  /**
   * 這個欄位直接寫進 `scopes.scope_kind`，所以型別是 `ScopeKind`（含 channel），
   * 不是上面那個查詢維度的 `ReportScopeKind`。官網就是 channel。
   */
  scopeKind: ScopeKind;
  name: string;
  active?: boolean;
  /** 自動匯入可指定通路，避免不同通路的同名據點互相衝突。 */
  sourceType?: string;
}

export interface ReportSalesQuery {
  range: ReportRange;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  groupBy?: ReportGroupBy[];
  sku?: string;
  category?: string;
  productName?: string;
  /** 以商品名稱模糊搜尋，或以系統 SKU 精確搜尋。 */
  productQuery?: string;
}

export interface ReportPayoutQuery {
  range: ReportRange;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  groupBy?: ReportGroupBy[];
}

export interface ReportSalesQueryResult {
  status: "ok" | "NO_DATA_FOR_RANGE" | "UNSUPPORTED_GRANULARITY";
  period: string;
  requestedStart: string;
  requestedEnd: string;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  rows: Array<Record<string, string | number | null>>;
  totals: {
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
  };
  message?: string;
}

export interface ReportPayoutQueryResult {
  status: "ok" | "NO_DATA_FOR_RANGE";
  period: string;
  requestedStart: string;
  requestedEnd: string;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  rows: Array<Record<string, string | number | null>>;
  totals: { payoutAmount: number };
  message?: string;
}

export class ReportScopeAmbiguousError extends Error {
  readonly code = "ambiguous_report_scope";

  constructor(scopeKind: ReportScopeKind, name: string) {
    super(`報表 ${scopeKind} scope 名稱「${name}」對應到多個啟用中的據點，請改用 scopeId。`);
    this.name = "ReportScopeAmbiguousError";
  }
}

export function normalizeReportScopeName(value: string): string {
  return value.trim().replace(/\s+/gu, "").toLocaleLowerCase();
}

export function parseReportRange(period?: string, startDate?: string, endDate?: string): ReportRange {
  const start = startDate?.trim();
  const end = endDate?.trim();
  if (Boolean(start) !== Boolean(end)) throw new Error("startDate 與 endDate 必須同時提供。");
  if (start && end) {
    if (!isDate(start) || !isDate(end) || start > end) throw new Error("日期區間必須是有效的 YYYY-MM-DD，且起日不可晚於迄日。");
    return { period: start.slice(0, 7) === end.slice(0, 7) ? start.slice(0, 7) : `${start}~${end}`, startDate: start, endDate: end, isCustom: true };
  }

  const value = period?.trim() ?? "";
  if (/^\d{4}$/.test(value)) return { period: value, startDate: `${value}-01-01`, endDate: `${value}-12-31` };
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const day = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
    return { period: value, startDate: `${value}-01`, endDate: `${value}-${String(day).padStart(2, "0")}` };
  }
  throw new Error("period 必須是 YYYY 或 YYYY-MM；若查詢自訂區間，請同時提供 startDate 與 endDate。");
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** API 寫入逐日資料時也要沿用查詢的日曆驗證，避免 SQLite 收進不存在的日期。 */
export function isValidReportDate(value: string): boolean {
  return isDate(value);
}

function asReportScope(scope: typeof targetScopes.$inferSelect): ReportScope {
  return {
    id: scope.id,
    sourceType: scope.sourceType,
    scopeKind: scope.scopeKind as ReportScopeKind,
    name: scope.name,
    normalizedName: scope.normalizedName,
    active: scope.active,
    createdAt: scope.createdAt,
    updatedAt: scope.updatedAt,
  };
}

/**
 * 還在營運、可以挑的通路。**只給挑選用**——執行頁、補登下拉這種「要新增資料」的
 * 地方。報表計算不能用這個，見 listAllReportScopes。
 */
export async function listReportScopes(db: Database, scopeKind?: ReportScopeKind): Promise<ReportScope[]> {
  const rows = await db.select().from(targetScopes)
    .where(and(eq(targetScopes.active, 1), scopeKind ? eq(targetScopes.scopeKind, scopeKind) : undefined))
    .orderBy(asc(targetScopes.name));
  return rows.map(asReportScope);
}

/**
 * 全部的通路，一個都不挑。
 *
 * 不看 source、不看 kind、不看 ID 格式、不看停用與封存。每個通路都會有自己的
 * 銷售明細與金額，只是顆粒度不同（出金有些是月結）——顆粒度是報表要處理的事，
 * 不是決定它算不算公司營收的條件。
 *
 * 含停用與封存尤其刻意。報表是歷史：一家店收掉之後，它過去的出金與銷售仍然是
 * 公司的營收，仍然要能查、仍然要進公司總額。用 active 濾名冊等於「關掉開關就把
 * 歷史抹掉一塊」，而且抹掉的當下沒有任何錯誤訊息——只是數字變小。
 */
export async function listAllReportScopes(db: Database): Promise<ReportScope[]> {
  const rows = await db.select().from(targetScopes).orderBy(asc(targetScopes.name));
  return rows.map(asReportScope);
}

function reportScopePriority(scopeId: string): number {
  if (scopeId.startsWith("cyberbiz:store:")) return 0;
  if (scopeId.startsWith("report:store:")) return 1;
  if (scopeId.startsWith("manual:store:")) return 2;
  if (scopeId.startsWith("payout:store:")) return 3;
  return 4;
}

/**
 * 挑選用的通路清單，**只給下拉選單**，不是報表要算哪些通路的依據。
 *
 * 兩件事：
 *
 * 1. 同一個業務據點只列一次。migration 會同時保留 CYBERBIZ report scope 與
 *    payout store scope，兩者名稱相同但 ID 不同，不能把兩列都丟給 UI。
 * 2. 排除 `company` kind。那一列是彙總的容器，本身沒有資料，出現在「選一個
 *    據點」的下拉裡只會讓人選到一個查不到東西的選項。
 *
 * **公司總額不套這個函式**——那裡一個通路都不挑，含停用、封存與彙總。挑選與
 * 計算是兩件事，混用就會變成「用現在的設定決定過去的數字」。
 */
export function canonicalReportStoreScopes(scopes: readonly ReportScope[]): ReportScope[] {
  const canonical = new Map<string, ReportScope>();
  for (const scope of scopes) {
    if (scope.scopeKind === "company") continue;
    const key = `${dataChannelFromScopeId(scope.id)}:${scope.normalizedName || scope.name}`;
    const current = canonical.get(key);
    if (!current || reportScopePriority(scope.id) < reportScopePriority(current.id)) canonical.set(key, scope);
  }
  return [...canonical.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hant"));
}

/**
 * 單次請求內共用的店別名冊。
 *
 * 一份統計會呼叫 queryReportSales / queryReportPayout 好幾次（本期、上期、
 * 去年同期、趨勢、店別、分類、SKU⋯），而每一次都要讀兩遍 report_scopes——
 * 一次解析 scope id、一次把 id 換成店名。八次查詢就是十六趟往返讀同一張表。
 *
 * 刻意做成傳進去的物件而不是模組層的快取：它的壽命必須剛好是一次請求，
 * 新增店別下一個請求就要看得到。
 */
export interface ReportScopeDirectory {
  stores(): Promise<ReportScope[]>;
  /** 指定店別時走這裡；同一組條件在一次請求內只查一次。 */
  store(lookup: { id?: string; name?: string }): Promise<ReportScope | null>;
}

export function createReportScopeDirectory(db: Database): ReportScopeDirectory {
  let all: Promise<ReportScope[]> | undefined;

  function stores(): Promise<ReportScope[]> {
    // 失敗的 promise 不能留下來，不然同一次請求後續的呼叫拿到的都是同一個錯誤，連重試都沒有。
    return (all ??= listAllReportScopes(db).catch((error) => {
      all = undefined;
      throw error;
    }));
  }

  return {
    stores,
    /*
     * 從同一份名冊推導，不另外查一次。名冊沒有任何篩選，所以跟 findReportScope
     * 的 id 分支完全等價，name 分支也只是比對 normalizedName
     * 再加上「超過一筆就是同名」，所以指定店別的下限是一次查詢而不是兩次。
     */
    async store(lookup) {
      const scopes = await stores();
      if (lookup.id) return scopes.find((scope) => scope.id === lookup.id) ?? null;
      if (!lookup.name) return null;
      const normalized = normalizeReportScopeName(lookup.name);
      const matched = scopes.filter((scope) => scope.normalizedName === normalized);
      if (matched.length > 1) throw new ReportScopeAmbiguousError("store", lookup.name);
      return matched[0] ?? null;
    },
  };
}

const TARGET_EFFECTIVE_SALES_SOURCE = sql`(
  SELECT
    sales.scope_id,
    sales.report_month,
    item.sku,
    item.name AS product_name,
    COALESCE(category.name, '未分類') AS category,
    parent_category.name AS category_parent,
    sales.gross_quantity,
    sales.return_quantity,
    sales.net_quantity,
    sales.sales_amount
  FROM report_item_sales_monthly AS sales
  JOIN items AS item ON item.id = sales.item_id
  LEFT JOIN item_categories AS category ON category.id = item.category_id
  LEFT JOIN item_categories AS parent_category ON parent_category.id = category.parent_id
  WHERE sales.record_origin = 'manual'
    OR (sales.record_origin = 'imported' AND NOT EXISTS (
      SELECT 1
      FROM report_item_sales_monthly AS manual
      WHERE manual.scope_id = sales.scope_id
        AND manual.report_month = sales.report_month
        AND manual.item_id = sales.item_id
        AND manual.record_origin = 'manual'
    ))
) AS report_sales_effective`;

const EFFECTIVE_SALES_COLUMNS = {
  scopeId: sql.raw("report_sales_effective.scope_id"),
  reportMonth: sql.raw("report_sales_effective.report_month"),
  sku: sql.raw("report_sales_effective.sku"),
  productName: sql.raw("report_sales_effective.product_name"),
  category: sql.raw("report_sales_effective.category"),
  categoryParent: sql.raw("report_sales_effective.category_parent"),
  grossQuantity: sql.raw("report_sales_effective.gross_quantity"),
  returnQuantity: sql.raw("report_sales_effective.return_quantity"),
  netQuantity: sql.raw("report_sales_effective.net_quantity"),
  salesAmount: sql.raw("report_sales_effective.sales_amount"),
};

const TARGET_EFFECTIVE_PAYOUT_SOURCE = sql`(
  SELECT
    target.scope_id,
    target.business_date,
    target.payout_amount
  FROM report_payout_daily AS target
  WHERE target.record_origin = 'manual'
    OR (target.record_origin = 'imported' AND NOT EXISTS (
      SELECT 1
      FROM report_payout_daily AS manual
      WHERE manual.scope_id = target.scope_id
        AND manual.business_date = target.business_date
        AND manual.record_origin = 'manual'
    ))
) AS report_payout_effective`;

const EFFECTIVE_PAYOUT_COLUMNS = {
  scopeId: sql.raw("report_payout_effective.scope_id"),
  businessDate: sql.raw("report_payout_effective.business_date"),
  payoutAmount: sql.raw("report_payout_effective.payout_amount"),
};

export interface LatestReportSalesPeriods {
  latestPeriod: string | null;
  byScope: Record<string, string>;
}

/** 回傳啟用中 scope 的最新商品銷售月份，供統計首頁選擇有資料的預設期間。 */
export async function latestReportSalesPeriods(
  db: Database,
  scopeIds: readonly string[],
): Promise<LatestReportSalesPeriods> {
  if (!scopeIds.length) return { latestPeriod: null, byScope: {} };

  const targetRows = await db.select({ scopeId: reportItemSalesMonthly.scopeId, reportMonth: sql<string | null>`max(${reportItemSalesMonthly.reportMonth})` })
    .from(reportItemSalesMonthly)
    .where(inArray(reportItemSalesMonthly.scopeId, [...scopeIds]))
    .groupBy(reportItemSalesMonthly.scopeId);

  const byScope: Record<string, string> = {};
  let latestPeriod: string | null = null;
  for (const row of targetRows) {
    if (!row.reportMonth) continue;
    const existing = byScope[row.scopeId];
    if (!existing || row.reportMonth > existing) byScope[row.scopeId] = row.reportMonth;
    if (!latestPeriod || row.reportMonth > latestPeriod) latestPeriod = row.reportMonth;
  }
  for (const period of Object.values(byScope)) {
    if (!latestPeriod || period > latestPeriod) latestPeriod = period;
  }
  return { latestPeriod, byScope };
}

/**
 * scope 的 source_type 是「哪個 driver 抓的」，不是「從哪張舊表來的」。
 * 值域是這個函式自己列的三個（shopee／manual／cyberbiz）；scopes.source_type 沒有 CHECK，
 * 因為之後加通路不想每次都重建整張表。
 *
 * 依據只能是 id 前綴：出金與銷售是同一家店、同一個 driver，用「這次在跑哪種報表」
 * 去決定會讓同一家店長出兩種 source_type——0078 就是這樣把 13 家店變成 26 列的。
 * manual scope 是人工補上的退租店，不是 runner 可執行的 CYBERBIZ POS 店。
 * 沒有前綴的是舊的 payout 店別（uuid），那些都是 CYBERBIZ POS。
 */
export function scopeSourceTypeFromId(scopeId: string): string {
  if (scopeId.startsWith("shopee:")) return "shopee";
  if (scopeId.startsWith("manual:")) return "manual";
  return "cyberbiz";
}

export async function upsertReportScope(db: Database, input: ReportScopeInput): Promise<ReportScope> {
  const now = new Date().toISOString();
  const name = input.name.trim();
  const normalizedName = normalizeReportScopeName(name);
  const active = input.active === false ? 0 : 1;
  const sourceType = input.sourceType?.trim().toLowerCase() || scopeSourceTypeFromId(input.id);
  await db.insert(targetScopes).values({
    id: input.id,
    sourceType,
    scopeKind: input.scopeKind,
    name,
    normalizedName,
    active,
    driveFolderUrl: "",
    driveFolderName: "",
    sortOrder: 0,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: targetScopes.id,
    set: { sourceType, scopeKind: input.scopeKind, name, normalizedName, active, updatedAt: now },
  });
  const [scope] = await db.select().from(targetScopes).where(eq(targetScopes.id, input.id)).limit(1);
  if (!scope) throw new Error("寫入 target 報表 scope 後找不到資料。");
  return asReportScope(scope);
}

export async function findReportScope(
  db: Database,
  input: { scopeKind: ReportScopeKind; id?: string; name?: string },
): Promise<ReportScope | null> {
  if (input.id) {
    const [scope] = await db.select().from(targetScopes).where(and(
      eq(targetScopes.id, input.id),
      eq(targetScopes.scopeKind, input.scopeKind),
      eq(targetScopes.active, 1),
    )).limit(1);
    return scope ? asReportScope(scope) : null;
  }
  if (!input.name) return null;
  const targetRows = await db.select().from(targetScopes).where(and(
    eq(targetScopes.scopeKind, input.scopeKind),
    eq(targetScopes.normalizedName, normalizeReportScopeName(input.name)),
    eq(targetScopes.active, 1),
  )).limit(2);
  if (targetRows.length > 1) throw new ReportScopeAmbiguousError(input.scopeKind, input.name);
  return targetRows[0] ? asReportScope(targetRows[0]) : null;
}

/** 月份匯入是一次性快照；即使當月零筆，也要清掉該據點該月份的舊 SKU。 */
export async function insertReportSalesMonthly(
  db: Database,
  rows: readonly NewReportSalesMonthly[],
  target?: { scopeId: string; reportMonth: string; replaceExisting?: boolean; reportRunId?: string },
): Promise<void> {
  type Statement = Parameters<Database["batch"]>[0][number];
  const months = new Map<string, {
    scopeId: string;
    reportMonth: string;
    rows: NewReportSalesMonthly[];
    replaceExisting: boolean;
  }>();
  const month = (scopeId: string, reportMonth: string, replaceExisting = true) => {
    const key = `${reportMonth}\u0000${scopeId}`;
    const existing = months.get(key);
    if (existing) {
      // 同一批次若由 target 補上一個空月份，target 的 merge 設定也要套用到既有 rows。
      if (!replaceExisting) existing.replaceExisting = false;
      return existing;
    }
    const created = { scopeId, reportMonth, rows: [] as NewReportSalesMonthly[], replaceExisting };
    months.set(key, created);
    return created;
  };
  for (const row of rows) month(row.scopeId, row.reportMonth).rows.push(row);
  if (target) month(target.scopeId, target.reportMonth, target.replaceExisting ?? true);

  // target schema 將每個 imported row 綁定到 report run；空月份也要執行 replace，清除舊資料。
  const targetEntries = target
    ? [{
      scopeId: target.scopeId,
      reportMonth: target.reportMonth,
      rows: rows.filter((row) => row.scopeId === target.scopeId && row.reportMonth === target.reportMonth),
      replaceExisting: target.replaceExisting !== false,
    }]
    : [...months.values()].map((entry) => ({ ...entry, replaceExisting: entry.replaceExisting }));
    const targetInputRows = targetEntries.flatMap((entry) => entry.rows);
    const targetMonths = targetEntries.map((entry) => entry.reportMonth).filter(Boolean).sort();
    const targetRunId = await ensureTargetImportRun(db, {
      reportRunId: target?.reportRunId,
      sourceType: "cyberbiz",
      importsSales: true,
      importsPayout: false,
      scopeIds: targetEntries.map((entry) => entry.scopeId),
      startDate: targetMonths.length ? `${targetMonths[0]}-01` : "1970-01-01",
      endDate: targetMonths.length ? (() => {
        const [year, month] = targetMonths.at(-1)!.split("-").map(Number);
        return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
      })() : "1970-01-01",
    });
    const itemsBySku = await ensureTargetSalesItems(db, targetInputRows, true);
    for (const entry of targetEntries) {
      const mappedRows = entry.rows.flatMap((row) => {
        const itemId = itemsBySku.get(row.sku.trim().toLowerCase());
        return itemId && targetRunId
          ? [{ scopeId: row.scopeId, reportMonth: row.reportMonth, itemId, recordOrigin: "imported" as const, reportRunId: targetRunId, grossQuantity: row.grossQuantity, returnQuantity: row.returnQuantity ?? 0, netQuantity: row.netQuantity, salesAmount: row.salesAmount }]
          : [];
      });
      const targetStatements: Statement[] = [];
      if (entry.replaceExisting) {
        targetStatements.push(db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, entry.scopeId), eq(reportItemSalesMonthly.reportMonth, entry.reportMonth), eq(reportItemSalesMonthly.recordOrigin, "imported"))));
      }
      for (const chunk of chunks(mappedRows, REPORT_SALES_WRITE_BATCH_SIZE)) {
        if (chunk.length) targetStatements.push(db.insert(reportItemSalesMonthly).values(chunk).onConflictDoUpdate({ target: [reportItemSalesMonthly.scopeId, reportItemSalesMonthly.reportMonth, reportItemSalesMonthly.itemId, reportItemSalesMonthly.recordOrigin], set: { reportRunId: targetRunId, grossQuantity: sql`excluded.gross_quantity`, returnQuantity: sql`excluded.return_quantity`, netQuantity: sql`excluded.net_quantity`, salesAmount: sql`excluded.sales_amount`, updatedAt: sql`CURRENT_TIMESTAMP` } }));
      }
      if (targetStatements.length) await db.batch(targetStatements as [Statement, ...Statement[]]);
    }
}

export interface NewReportSalesPeriodRow {
  sku: string;
  productName?: string;
  category?: string;
  grossQuantity: number;
  returnQuantity?: number;
  netQuantity: number;
  salesAmount: number;
}

/**
 * 匯入一份「期間」報表，然後重算它所屬月份的月報。
 *
 * 給的是 CYBERBIZ 官網的半月對帳表：一個月兩份檔案，區間不能自己選。直接寫月報的話
 * 第二份會覆蓋第一份；改成累加又會讓同一份重傳加兩遍。所以來源存在
 * report_item_sales_period（主鍵含期間），月報是它的加總——重傳只換掉那一期，
 * 兩份半月檔自然相加。
 *
 * **同一個 scope 不可以同時走月報與期間兩條路。** 這裡會把該月的 imported 月報整批
 * 重建成「期間的總和」，所以如果有人另外用月報直寫同一個 scope 的同一個月，那些列
 * 會在下一次期間匯入時消失。實體店走月報、官網走期間，兩邊的 scope 不重疊。
 */
export async function insertReportSalesPeriod(
  db: Database,
  input: {
    scopeId: string;
    periodStart: string;
    periodEnd: string;
    reportRunId?: string;
    rows: readonly NewReportSalesPeriodRow[];
  },
): Promise<{ reportMonth: string; itemCount: number; salesAmount: number }> {
  type Statement = Parameters<Database["batch"]>[0][number];
  const { scopeId, periodStart, periodEnd } = input;
  const reportMonth = periodStart.slice(0, 7);
  if (periodEnd.slice(0, 7) !== reportMonth) {
    throw new Error(`期間跨月無法併入月報：${periodStart} ~ ${periodEnd}`);
  }

  const runId = await ensureTargetImportRun(db, {
    reportRunId: input.reportRunId,
    sourceType: "cyberbiz",
    importsSales: true,
    importsPayout: false,
    scopeIds: [scopeId],
    startDate: periodStart,
    endDate: periodEnd,
  });
  if (!runId) throw new Error("建立報表執行紀錄失敗。");

  const itemsBySku = await ensureTargetSalesItems(
    db,
    input.rows.map((row) => ({ ...row, scopeId, reportMonth, returnQuantity: row.returnQuantity ?? 0 })),
    true,
  );
  const periodRows = input.rows.flatMap((row) => {
    const itemId = itemsBySku.get(row.sku.trim().toLowerCase());
    return itemId ? [{
      scopeId,
      periodStart,
      periodEnd,
      reportMonth,
      itemId,
      reportRunId: runId,
      grossQuantity: row.grossQuantity,
      returnQuantity: row.returnQuantity ?? 0,
      netQuantity: row.netQuantity,
      salesAmount: row.salesAmount,
    }] : [];
  });

  // 先清掉這一期的舊列再寫入，重傳同一份檔案的結果才會跟第一次一樣。
  const writes: Statement[] = [db.delete(reportItemSalesPeriod).where(and(
    eq(reportItemSalesPeriod.scopeId, scopeId),
    eq(reportItemSalesPeriod.periodStart, periodStart),
    eq(reportItemSalesPeriod.periodEnd, periodEnd),
  ))];
  for (const chunk of chunks(periodRows, REPORT_SALES_WRITE_BATCH_SIZE)) {
    if (chunk.length) writes.push(db.insert(reportItemSalesPeriod).values(chunk));
  }
  await db.batch(writes as [Statement, ...Statement[]]);

  // 月報 = 該月各期間的總和。先讀出加總再寫，不用 INSERT … SELECT：raw run 不是
  // D1 batch 收得下的 prepared statement，混進 batch 會在執行時炸掉。
  const totals = await db.select({
    itemId: reportItemSalesPeriod.itemId,
    grossQuantity: sum(reportItemSalesPeriod.grossQuantity).mapWith(Number),
    returnQuantity: sum(reportItemSalesPeriod.returnQuantity).mapWith(Number),
    netQuantity: sum(reportItemSalesPeriod.netQuantity).mapWith(Number),
    salesAmount: sum(reportItemSalesPeriod.salesAmount).mapWith(Number),
  }).from(reportItemSalesPeriod)
    .where(and(eq(reportItemSalesPeriod.scopeId, scopeId), eq(reportItemSalesPeriod.reportMonth, reportMonth)))
    .groupBy(reportItemSalesPeriod.itemId);

  // 整批重建而不是逐列 upsert：某一期的某個 SKU 這次沒出現（更正檔少一列、商品
  // 下架）時，upsert 不會把上一次的殘留清掉，月報就會多一筆憑空的錢。
  const monthlyWrites: Statement[] = [db.delete(reportItemSalesMonthly).where(and(
    eq(reportItemSalesMonthly.scopeId, scopeId),
    eq(reportItemSalesMonthly.reportMonth, reportMonth),
    eq(reportItemSalesMonthly.recordOrigin, "imported"),
  ))];
  const monthlyRows = totals.map((row) => ({
    scopeId,
    reportMonth,
    itemId: row.itemId,
    recordOrigin: "imported" as const,
    reportRunId: runId,
    grossQuantity: row.grossQuantity,
    returnQuantity: row.returnQuantity,
    netQuantity: row.netQuantity,
    salesAmount: row.salesAmount,
  }));
  for (const chunk of chunks(monthlyRows, REPORT_SALES_WRITE_BATCH_SIZE)) {
    if (chunk.length) monthlyWrites.push(db.insert(reportItemSalesMonthly).values(chunk));
  }
  await db.batch(monthlyWrites as [Statement, ...Statement[]]);

  return {
    reportMonth,
    itemCount: periodRows.length,
    salesAmount: periodRows.reduce((sum, row) => sum + row.salesAmount, 0),
  };
}

export async function insertReportPayoutDaily(db: Database, rows: readonly NewReportPayoutDaily[], reportRunId?: string): Promise<void> {
  if (rows.length) {
    const dates = rows.map((row) => row.businessDate).sort();
    const targetId = await ensureTargetImportRun(db, {
      reportRunId,
      sourceType: "cyberbiz",
      importsSales: false,
      importsPayout: true,
      scopeIds: rows.map((row) => row.scopeId),
      startDate: dates[0]!,
      endDate: dates.at(-1)!,
    });
    if (!targetId) return;
    const targetRows = rows.map((row) => ({ scopeId: row.scopeId, businessDate: row.businessDate, recordOrigin: "imported" as const, reportRunId: targetId, payoutAmount: row.payoutAmount }));
    for (const chunk of chunks(targetRows, REPORT_PAYOUT_WRITE_BATCH_SIZE)) {
      await db.batch([db.insert(reportPayoutDaily).values(chunk).onConflictDoUpdate({ target: [reportPayoutDaily.scopeId, reportPayoutDaily.businessDate, reportPayoutDaily.recordOrigin], set: { reportRunId: targetId, payoutAmount: sql`excluded.payout_amount`, updatedAt: sql`CURRENT_TIMESTAMP` } })]);
    }
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

type SalesGroupBy = Exclude<ReportGroupBy, "day">;

const SALES_GROUPS: Record<SalesGroupBy, { alias: string; expression: ReturnType<typeof sql> }> = {
  month: { alias: "reportMonth", expression: EFFECTIVE_SALES_COLUMNS.reportMonth },
  scope: { alias: "scopeId", expression: EFFECTIVE_SALES_COLUMNS.scopeId },
  sku: { alias: "sku", expression: EFFECTIVE_SALES_COLUMNS.sku },
  category: { alias: "category", expression: EFFECTIVE_SALES_COLUMNS.category },
};

type PayoutGroupBy = "day" | "month" | "scope";

const PAYOUT_GROUPS: Record<PayoutGroupBy, { alias: string; expression: ReturnType<typeof sql> }> = {
  day: { alias: "businessDate", expression: EFFECTIVE_PAYOUT_COLUMNS.businessDate },
  month: { alias: "reportMonth", expression: sql`substr(${EFFECTIVE_PAYOUT_COLUMNS.businessDate}, 1, 7)` },
  scope: { alias: "scopeId", expression: EFFECTIVE_PAYOUT_COLUMNS.scopeId },
};

function selectedGroups(groups: readonly ReportGroupBy[] | undefined): SalesGroupBy[] {
  return [...new Set(groups?.filter((group): group is SalesGroupBy => group !== "day" && group in SALES_GROUPS) ?? [])];
}

function selectedPayoutGroups(groups: readonly ReportGroupBy[] | undefined): PayoutGroupBy[] {
  return [...new Set(groups?.filter((group): group is PayoutGroupBy => group === "day" || group === "month" || group === "scope") ?? [])];
}

function scopeCondition(column: ReturnType<typeof sql>, scopeIds: readonly string[]) {
  return scopeIds.length === 1
    ? sql`${column} = ${scopeIds[0]}`
    : sql`${column} IN (${sql.join(scopeIds.map((id) => sql`${id}`), sql`, `)})`;
}

export async function scopeIdsForQuery(
  db: Database,
  query: { scopeType: ReportScopeKind; scopeId?: string; scopeName?: string },
  directory: ReportScopeDirectory = createReportScopeDirectory(db),
): Promise<{ ids: string[]; scope?: ReportScope }> {
  if (query.scopeType === "store") {
    const scope = await directory.store({ id: query.scopeId, name: query.scopeName });
    if (!scope) return { ids: [] };
    // 同一店別可能同時有 CYBERBIZ 與 payout 的 scope ID；查單店時兩邊資料要一起算。
    // 同名才合併，而且限定同一個 source：這裡要處理的是「同一家店在 migration
    // 期間留下 CYBERBIZ 與 payout 兩個 ID」，不是把同名的蝦皮賣場也算進實體店。
    const aliases = (await directory.stores())
      .filter((candidate) => candidate.sourceType === scope.sourceType
        && candidate.scopeKind === scope.scopeKind
        && candidate.normalizedName === scope.normalizedName)
      .map((candidate) => candidate.id);
    return { ids: aliases.length ? aliases : [scope.id], scope };
  }
  // 公司總額納入每一個通路，一個都不挑。
  return { ids: (await directory.stores()).map((scope) => scope.id) };
}

function queryConditions(
  dateColumn: ReturnType<typeof sql>,
  scopeColumn: ReturnType<typeof sql>,
  range: ReportRange,
  scopeIds: readonly string[],
) {
  return sql.join([
    sql`${dateColumn} >= ${range.startDate}`,
    sql`${dateColumn} <= ${range.endDate}`,
    scopeCondition(scopeColumn, scopeIds),
  ], sql` AND `);
}

function monthConditions(
  monthColumn: ReturnType<typeof sql>,
  scopeColumn: ReturnType<typeof sql>,
  range: ReportRange,
  scopeIds: readonly string[],
) {
  return sql.join([
    sql`${monthColumn} >= ${range.startDate.slice(0, 7)}`,
    sql`${monthColumn} <= ${range.endDate.slice(0, 7)}`,
    scopeCondition(scopeColumn, scopeIds),
  ], sql` AND `);
}

function isWholeMonthRange(range: ReportRange): boolean {
  if (!range.startDate.endsWith("-01")) return false;
  const [year, month] = range.endDate.slice(0, 7).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return range.endDate === `${range.endDate.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function queryReportSales(
  db: Database,
  query: ReportSalesQuery,
  directory: ReportScopeDirectory = createReportScopeDirectory(db),
): Promise<ReportSalesQueryResult | null> {
  if (!isWholeMonthRange(query.range)) {
    return {
      status: "UNSUPPORTED_GRANULARITY",
      period: query.range.period,
      requestedStart: query.range.startDate,
      requestedEnd: query.range.endDate,
      scopeType: query.scopeType,
      rows: [],
      totals: { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 },
      message: "商品銷售資料目前只支援完整月份查詢，請改用 YYYY-MM 或完整月份的起訖日期。",
    };
  }
  const { ids, scope } = await scopeIdsForQuery(db, query, directory);
  if (!ids.length) return null;
  const groups = selectedGroups(query.groupBy?.length ? query.groupBy : ["sku"]);
  const dimensions = groups.map((group) => SALES_GROUPS[group]);
  const effectiveSalesSource = TARGET_EFFECTIVE_SALES_SOURCE;
  const requestedSku = query.sku?.trim();
  const productQuery = query.productQuery?.trim();
  // 這次查詢涵蓋的通路；未指定通路的歷史 mapping 仍保留相容查詢。
  const aliasChannels = [...new Set(ids.map(dataChannelFromScopeId))];
  const baseAlias = requestedSku ? shopeeBaseExternalSku(requestedSku) : "";
  const aliasKeys = requestedSku
    ? [...new Set([requestedSku, ...(baseAlias ? [baseAlias] : [])])]
    : [];
  const filters = [
    monthConditions(EFFECTIVE_SALES_COLUMNS.reportMonth, EFFECTIVE_SALES_COLUMNS.scopeId, query.range, ids),
    /*
     * 外部 SKU 也查得到，但不能因此把別的商品算進來。
     *
     * 四道限制：
     * (1) 只有查詢值本身不是任何 WMS SKU 時才走 mapping 這條路。external_sku 允許等於
     *     另一個商品的 WMS SKU（見「外部 SKU 等於非第一順位用料的 WMS SKU 不算衝突」），
     *     不擋的話查香皂會連整個組合的資料一起加總。
     * (2) 只認一對一的對應。report_sales_monthly 是以 SKU 為粒度，沒有保留「這筆組合貢獻
     *     了多少」，所以組合的用料數字裡混著該用料的直接銷售與其他組合的展開——把那個
     *     總和當成這個組合的銷售回報出去會是錯的。
     * (3) 只認這次查詢涵蓋的通路（外加未指定通路的歷史資料）。只比 external_sku 的話，
     *     CYBERBIZ 的別名會撈出蝦皮同一個正式 SKU 的資料列，即使蝦皮根本沒有那個別名。
     * (4) 對應寫進報表的 SKU 一律從用料即時解析（WMS 商品或報表自訂商品），不留第二份
     *     快照——商品改名 SKU 之後快照不會跟著動，匯入寫新值、查詢查舊值就會查無資料。
     *
     * 蝦皮的基礎鍵另外吃 shopeeBaseExternalSku：匯入端允許「商品ID_規格ID」回退到只有
     * 商品 ID 的舊 mapping，查詢端沒有跟上的話同一個值查得到匯入卻查不到報表。
     */
    ...(requestedSku ? [sql`(
      lower(${EFFECTIVE_SALES_COLUMNS.sku}) = lower(${requestedSku})
      OR (
        NOT EXISTS (
          SELECT 1
          FROM wms_items AS queried_wms
          JOIN items AS queried_item ON queried_item.id = queried_wms.item_id
          WHERE lower(queried_item.sku) = lower(${requestedSku})
        )
        AND EXISTS (
        SELECT 1
        FROM report_external_products AS mapping
        JOIN items AS mapped_item ON mapped_item.id = mapping.item_id
        LEFT JOIN item_components AS component ON component.parent_item_id = mapping.item_id
        LEFT JOIN items AS component_item ON component_item.id = component.component_item_id
        WHERE mapping.resolution = 'mapped'
          AND mapping.source_type IN (${sql.join(aliasChannels.map((channel) => sql`${channel}`), sql`, `)})
          AND mapping.source_type = CASE
            WHEN ${EFFECTIVE_SALES_COLUMNS.scopeId} LIKE 'shopee:%' THEN 'shopee'
            WHEN ${EFFECTIVE_SALES_COLUMNS.scopeId} LIKE 'manual:%' THEN 'cyberbiz'
            WHEN ${EFFECTIVE_SALES_COLUMNS.scopeId} LIKE 'report:%' THEN 'cyberbiz'
            WHEN ${EFFECTIVE_SALES_COLUMNS.scopeId} LIKE 'payout:%' THEN 'cyberbiz'
            WHEN ${EFFECTIVE_SALES_COLUMNS.scopeId} LIKE 'store-%' THEN 'cyberbiz'
            WHEN instr(${EFFECTIVE_SALES_COLUMNS.scopeId}, ':') > 0 THEN substr(${EFFECTIVE_SALES_COLUMNS.scopeId}, 1, instr(${EFFECTIVE_SALES_COLUMNS.scopeId}, ':') - 1)
            ELSE 'cyberbiz'
          END
          AND mapping.external_key IN (${sql.join(aliasKeys.map((key) => sql`upper(trim(${key}))`), sql`, `)})
          AND (lower(mapped_item.sku) = lower(${EFFECTIVE_SALES_COLUMNS.sku}) OR lower(component_item.sku) = lower(${EFFECTIVE_SALES_COLUMNS.sku}))
        )
      )
    )`] : []),
    ...(query.category ? [sql`lower(${EFFECTIVE_SALES_COLUMNS.category}) = lower(${query.category})`] : []),
    ...(query.productName ? [sql`lower(${EFFECTIVE_SALES_COLUMNS.productName}) LIKE lower(${`%${query.productName}%`})`] : []),
    ...(productQuery ? [sql`(
      lower(${EFFECTIVE_SALES_COLUMNS.productName}) LIKE lower(${`%${productQuery}%`})
      OR lower(${EFFECTIVE_SALES_COLUMNS.sku}) = lower(${productQuery})
    )`] : []),
  ];
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    ...(groups.includes("sku") ? [sql`MAX(${EFFECTIVE_SALES_COLUMNS.productName}) AS productName`] : []),
    ...(groups.includes("category") ? [sql`MAX(${EFFECTIVE_SALES_COLUMNS.categoryParent}) AS categoryParent`] : []),
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.grossQuantity}) AS grossQuantity`,
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.returnQuantity}) AS returnQuantity`,
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.netQuantity}) AS netQuantity`,
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.salesAmount}) AS salesAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${effectiveSalesSource} WHERE ${sql.join(filters, sql` AND `)}${grouped}${order}`);
  const emptyAggregate = rows.length > 0 && rows.every((row) => (
    row.grossQuantity == null && row.returnQuantity == null && row.netQuantity == null && row.salesAmount == null
  ));
  if (!rows.length || emptyAggregate) {
    const coverage = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count FROM ${effectiveSalesSource} WHERE ${monthConditions(
      EFFECTIVE_SALES_COLUMNS.reportMonth,
      EFFECTIVE_SALES_COLUMNS.scopeId,
      query.range,
      ids,
    )}`);
    if (asNumber(coverage[0]?.count) === 0) return null;
    return {
      status: "ok",
      period: query.range.period,
      requestedStart: query.range.startDate,
      requestedEnd: query.range.endDate,
      scopeType: query.scopeType,
      ...(scope ? { scopeId: scope.id, scopeName: scope.name } : {}),
      rows: [],
      totals: { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 },
      message: "指定區間已有匯入的商品銷售資料，但沒有符合目前篩選條件的資料；請調整 SKU、分類或商品名稱。",
    };
  }

  const scopeNames = new Map((await directory.stores()).map((item) => [item.id, item.name]));
  const resultRows = rows.map((row) => ({
    ...row,
    ...(row.scopeId ? { scopeName: scopeNames.get(String(row.scopeId)) ?? String(row.scopeId) } : {}),
    grossQuantity: asNumber(row.grossQuantity),
    returnQuantity: asNumber(row.returnQuantity),
    netQuantity: asNumber(row.netQuantity),
    salesAmount: asNumber(row.salesAmount),
  }));
  return {
    status: "ok",
    period: query.range.period,
    requestedStart: query.range.startDate,
    requestedEnd: query.range.endDate,
    scopeType: query.scopeType,
    ...(scope ? { scopeId: scope.id, scopeName: scope.name } : {}),
    rows: resultRows,
    totals: resultRows.reduce((totals, row) => ({
      grossQuantity: totals.grossQuantity + asNumber(row.grossQuantity),
      returnQuantity: totals.returnQuantity + asNumber(row.returnQuantity),
      netQuantity: totals.netQuantity + asNumber(row.netQuantity),
      salesAmount: totals.salesAmount + asNumber(row.salesAmount),
    }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 }),
  };
}

export async function queryReportPayout(
  db: Database,
  query: ReportPayoutQuery,
  directory: ReportScopeDirectory = createReportScopeDirectory(db),
): Promise<ReportPayoutQueryResult | null> {
  const { ids, scope } = await scopeIdsForQuery(db, query, directory);
  if (!ids.length) return null;
  const effectivePayoutSource = TARGET_EFFECTIVE_PAYOUT_SOURCE;
  const groups = selectedPayoutGroups(query.groupBy?.length ? query.groupBy : ["day"]);
  const dimensions = groups.map((group) => PAYOUT_GROUPS[group]);
  const conditions = queryConditions(EFFECTIVE_PAYOUT_COLUMNS.businessDate, EFFECTIVE_PAYOUT_COLUMNS.scopeId, query.range, ids);
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    sql`SUM(${EFFECTIVE_PAYOUT_COLUMNS.payoutAmount}) AS payoutAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${effectivePayoutSource} WHERE ${conditions}${grouped}${order}`);
  if (!rows.length || (dimensions.length === 0 && rows.every((row) => row.payoutAmount == null))) return null;
  const scopeNames = new Map((await directory.stores()).map((item) => [item.id, item.name]));
  const resultRows = rows.map((row) => ({
    ...row,
    ...(row.scopeId ? { scopeName: scopeNames.get(String(row.scopeId)) ?? String(row.scopeId) } : {}),
    payoutAmount: asNumber(row.payoutAmount),
  }));
  return {
    status: "ok",
    period: query.range.period,
    requestedStart: query.range.startDate,
    requestedEnd: query.range.endDate,
    scopeType: query.scopeType,
    ...(scope ? { scopeId: scope.id, scopeName: scope.name } : {}),
    rows: resultRows,
    totals: { payoutAmount: resultRows.reduce((total, row) => total + asNumber(row.payoutAmount), 0) },
  };
}
