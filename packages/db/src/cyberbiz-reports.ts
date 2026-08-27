import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  cyberbizReportManifests,
  cyberbizReportRuns,
  type CyberbizReportManifest,
  type CyberbizReportKind,
  type CyberbizReportRun,
  type CyberbizReportScopeType,
  type CyberbizReportRunKind,
  type CyberbizReportStatus,
} from "./schema/cyberbiz-reports.js";

export type { CyberbizReportKind, CyberbizReportRun, CyberbizReportRunKind } from "./schema/cyberbiz-reports.js";

export interface CyberbizManifestLookup {
  reportMonth: string;
  scopeType: CyberbizReportScopeType;
  scopeId?: string;
  scopeName?: string;
  status?: CyberbizReportStatus;
  /** 只取帶有該 normalized JSON 的最新版本，讓 sales／payout 可分開 publish。 */
  requiredArtifact?: Exclude<CyberbizReportKind, "bundle">;
}

/** 查詢回應使用的索引摘要，不把 NAS object key 暴露給 AI。 */
export type CyberbizReportManifestSummary = Pick<
  CyberbizReportManifest,
  "id" | "reportMonth" | "reportKind" | "scopeType" | "scopeId" | "scopeName" | "coverageStart" | "coverageEnd" | "sourceChecksum"
>;

export interface CyberbizSalesRow {
  sku: string;
  productName: string;
  category: string;
  barcode?: string;
  unitPrice: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  costAmount?: number;
  grossProfit?: number;
  grossMargin?: number;
}

export interface CyberbizSalesDocument {
  schemaVersion: 1;
  kind: "cyberbiz_sales_monthly";
  scopeType: CyberbizReportScopeType;
  scopeId: string;
  scopeName: string;
  reportMonth: string;
  coverageStart: string;
  coverageEnd: string;
  granularity: "month";
  rows: CyberbizSalesRow[];
  totals: {
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
  };
  source?: {
    filename?: string;
    checksum?: string;
    parserVersion?: string;
  };
}

export interface CyberbizPayoutRow {
  date: string;
  closeAt: string;
  incomeAmount: number;
  incomeType: string;
  pos: string;
  operator: string;
}

export interface CyberbizPayoutDocument {
  schemaVersion: 1;
  kind: "cyberbiz_payout_daily";
  scopeType: CyberbizReportScopeType;
  scopeId: string;
  scopeName: string;
  reportMonth: string;
  coverageStart: string;
  coverageEnd: string;
  granularity: "day";
  rows: CyberbizPayoutRow[];
  totals: { incomeAmount: number; rowCount: number };
  source?: { filename?: string; checksum?: string; parserVersion?: string };
}

export interface CyberbizSalesQuery {
  reportMonth: string;
  scopeType: CyberbizReportScopeType;
  scopeId?: string;
  scopeName?: string;
  startDate?: string;
  endDate?: string;
  sku?: string;
  category?: string;
  productName?: string;
}

export type CyberbizSalesQueryResult =
  | { status: "ok"; reportMonth: string; scopeType: CyberbizReportScopeType; scopeId?: string; scopeName?: string; rows: CyberbizSalesRow[]; totals: CyberbizSalesDocument["totals"]; manifest: CyberbizReportManifestSummary }
  | { status: "NO_DATA_FOR_RANGE" | "INCOMPLETE_COVERAGE" | "UNSUPPORTED_GRANULARITY"; reportMonth: string; requestedStart: string; requestedEnd: string; message: string };

export interface CyberbizPayoutQuery {
  reportMonth: string;
  scopeType: CyberbizReportScopeType;
  scopeId?: string;
  scopeName?: string;
  startDate: string;
  endDate: string;
  incomeType?: string;
  pos?: string;
  operator?: string;
}

export type CyberbizPayoutQueryResult =
  | { status: "ok"; reportMonth: string; scopeType: CyberbizReportScopeType; scopeId?: string; scopeName?: string; rows: CyberbizPayoutRow[]; totals: CyberbizPayoutDocument["totals"]; manifest: CyberbizReportManifestSummary }
  | { status: "NO_DATA_FOR_RANGE" | "INCOMPLETE_COVERAGE" | "UNSUPPORTED_GRANULARITY"; reportMonth: string; requestedStart: string; requestedEnd: string; message: string };

export function normalizeCyberbizMonth(value: string): string {
  const month = value.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("CYBERBIZ 報表月份必須使用 YYYY-MM 格式。");
  }
  return month;
}

function monthRange(reportMonth: string): { start: string; end: string } {
  const [year = 0, month = 0] = reportMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${reportMonth}-01`,
    end: `${reportMonth}-${String(lastDay).padStart(2, "0")}`,
  };
}

export async function listCyberbizReportManifests(
  db: Database,
  lookup: CyberbizManifestLookup,
): Promise<CyberbizReportManifest[]> {
  const conditions = [
    eq(cyberbizReportManifests.reportMonth, normalizeCyberbizMonth(lookup.reportMonth)),
    eq(cyberbizReportManifests.scopeType, lookup.scopeType),
    ...(lookup.scopeId ? [eq(cyberbizReportManifests.scopeId, lookup.scopeId)] : []),
    ...(lookup.status ? [eq(cyberbizReportManifests.status, lookup.status)] : []),
    ...(lookup.requiredArtifact === "sales" ? [isNotNull(cyberbizReportManifests.salesObjectKey)] : []),
    ...(lookup.requiredArtifact === "payout" ? [isNotNull(cyberbizReportManifests.payoutObjectKey)] : []),
  ];
  return db
    .select()
    .from(cyberbizReportManifests)
    .where(and(...conditions))
    .orderBy(desc(cyberbizReportManifests.updatedAt));
}

export async function findCyberbizReportManifest(
  db: Database,
  lookup: CyberbizManifestLookup,
): Promise<CyberbizReportManifest | null> {
  const [manifest] = await listCyberbizReportManifests(db, {
    ...lookup,
    status: lookup.status ?? "published",
  });
  return manifest ?? null;
}

function normalizedScopeName(value: string): string {
  return value.trim().replace(/\s+/gu, "").toLocaleLowerCase();
}

/**
 * 將同一個 report month／scope 下分開 publish 的 artifact 組成一個查詢視圖。
 *
 * reportKind 保留在資料表中是為了相容既有版本與各自重跑；scope 本身不應因為
 * artifact 是 sales 或 payout 而分裂。這個視圖也讓未來其他通路可以沿用同一個
 * scope 索引，而由各通路自行決定 normalized document 的解讀方式。
 */
export async function findCyberbizReportScopeManifest(
  db: Database,
  lookup: CyberbizManifestLookup,
): Promise<CyberbizReportManifest | null> {
  const manifests = await listCyberbizReportManifests(db, {
    ...lookup,
    status: lookup.status ?? "published",
    requiredArtifact: undefined,
  });
  const named = lookup.scopeName
    ? manifests.filter((manifest) => normalizedScopeName(manifest.scopeName) === normalizedScopeName(lookup.scopeName!))
    : manifests;
  const scopeIds = [...new Set(named.map((manifest) => manifest.scopeId))];
  if (scopeIds.length !== 1) return null;

  // 先用 scopeName 找到 canonical scope，再把同一 scope 的舊 artifact 一起帶入；
  // 舊版資料可能只有其中一筆填過 scopeName。
  const scopeManifests = manifests.filter((manifest) => manifest.scopeId === scopeIds[0]);
  const artifactManifest = lookup.requiredArtifact === "sales"
    ? scopeManifests.find((manifest) => Boolean(manifest.salesObjectKey))
    : lookup.requiredArtifact === "payout"
      ? scopeManifests.find((manifest) => Boolean(manifest.payoutObjectKey))
      : scopeManifests[0];
  if (!artifactManifest) return null;

  const salesManifest = scopeManifests.find((manifest) => Boolean(manifest.salesObjectKey));
  const payoutManifest = scopeManifests.find((manifest) => Boolean(manifest.payoutObjectKey));
  const combinedManifest = scopeManifests.find((manifest) => Boolean(manifest.combinedWorkbookObjectKey));
  return {
    ...artifactManifest,
    reportKind: salesManifest && payoutManifest ? "bundle" : artifactManifest.reportKind,
    scopeName: artifactManifest.scopeName || salesManifest?.scopeName || payoutManifest?.scopeName || "",
    salesSourceObjectKey: salesManifest?.salesSourceObjectKey ?? artifactManifest.salesSourceObjectKey,
    salesObjectKey: salesManifest?.salesObjectKey ?? artifactManifest.salesObjectKey,
    payoutSourceObjectKey: payoutManifest?.payoutSourceObjectKey ?? artifactManifest.payoutSourceObjectKey,
    payoutObjectKey: payoutManifest?.payoutObjectKey ?? artifactManifest.payoutObjectKey,
    combinedWorkbookObjectKey: combinedManifest?.combinedWorkbookObjectKey ?? artifactManifest.combinedWorkbookObjectKey,
  };
}

export async function recordCyberbizReportManifest(
  db: Database,
  input: Omit<CyberbizReportManifest, "id" | "createdAt" | "updatedAt" | "salesSourceObjectKey" | "payoutSourceObjectKey" | "reportKind"> & {
    id?: string;
    reportKind?: CyberbizReportKind;
    salesSourceObjectKey?: string | null;
    payoutSourceObjectKey?: string | null;
  },
): Promise<CyberbizReportManifest> {
  const values = {
    ...input,
    reportKind: input.reportKind ?? "bundle",
    salesSourceObjectKey: input.salesSourceObjectKey ?? null,
    payoutSourceObjectKey: input.payoutSourceObjectKey ?? null,
    salesObjectKey: input.salesObjectKey ?? null,
    payoutObjectKey: input.payoutObjectKey ?? null,
    combinedWorkbookObjectKey: input.combinedWorkbookObjectKey ?? null,
    driveFileId: input.driveFileId ?? null,
    driveUrl: input.driveUrl ?? null,
    id: input.id ?? crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  await db.insert(cyberbizReportManifests).values(values).onConflictDoUpdate({
    target: [
      cyberbizReportManifests.reportMonth,
      cyberbizReportManifests.scopeType,
      cyberbizReportManifests.scopeId,
      cyberbizReportManifests.reportKind,
      cyberbizReportManifests.sourceChecksum,
    ],
    set: {
      scopeName: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.scopeName} ELSE excluded.scope_name END`,
      coverageStart: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.coverageStart} ELSE excluded.coverage_start END`,
      coverageEnd: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.coverageEnd} ELSE excluded.coverage_end END`,
      salesGranularity: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.salesGranularity} ELSE excluded.sales_granularity END`,
      payoutGranularity: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.payoutGranularity} ELSE excluded.payout_granularity END`,
      salesSourceObjectKey: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.salesSourceObjectKey} ELSE excluded.sales_source_object_key END`,
      payoutSourceObjectKey: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.payoutSourceObjectKey} ELSE excluded.payout_source_object_key END`,
      salesObjectKey: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.salesObjectKey} ELSE excluded.sales_object_key END`,
      payoutObjectKey: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.payoutObjectKey} ELSE excluded.payout_object_key END`,
      combinedWorkbookObjectKey: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.combinedWorkbookObjectKey} ELSE excluded.combined_workbook_object_key END`,
      driveFileId: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.driveFileId} ELSE excluded.drive_file_id END`,
      driveUrl: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.driveUrl} ELSE excluded.drive_url END`,
      storeIdsJson: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.storeIdsJson} ELSE excluded.store_ids_json END`,
      parserVersion: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.parserVersion} ELSE excluded.parser_version END`,
      status: sql`CASE WHEN ${cyberbizReportManifests.status} = 'published' AND excluded.status = 'staged' THEN ${cyberbizReportManifests.status} ELSE excluded.status END`,
      updatedAt: values.updatedAt,
    },
  });
  const found = (await listCyberbizReportManifests(db, {
    reportMonth: input.reportMonth,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  })).find((manifest) => manifest.sourceChecksum === input.sourceChecksum && manifest.reportKind === (input.reportKind ?? "bundle"));
  if (!found) throw new Error("寫入 CYBERBIZ report manifest 後找不到資料。");
  return found;
}

export async function recordCyberbizReportRun(
  db: Database,
  input: {
    requestId: string;
    reportKind: CyberbizReportRunKind;
    periodKind: "month" | "custom";
    stores: string[];
    startDate: string;
    endDate: string;
    actor: { id: string; email: string };
  },
): Promise<CyberbizReportRun> {
  const [run] = await db.insert(cyberbizReportRuns).values({
    id: crypto.randomUUID(),
    requestId: input.requestId,
    reportKind: input.reportKind,
    periodKind: input.periodKind,
    storesJson: JSON.stringify(input.stores),
    startDate: input.startDate,
    endDate: input.endDate,
    manifestEligible: input.periodKind === "month" ? 1 : 0,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
  }).returning();
  if (!run) throw new Error("寫入 CYBERBIZ report job 後找不到資料。");
  return run;
}

export async function listCyberbizReportRuns(
  db: Database,
  reportKind?: CyberbizReportRunKind,
  limit = 20,
): Promise<CyberbizReportRun[]> {
  return db.select().from(cyberbizReportRuns)
    .where(reportKind ? eq(cyberbizReportRuns.reportKind, reportKind) : undefined)
    .orderBy(desc(cyberbizReportRuns.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
}

export async function findCyberbizReportRun(db: Database, requestId: string): Promise<CyberbizReportRun | null> {
  const [run] = await db.select().from(cyberbizReportRuns)
    .where(eq(cyberbizReportRuns.requestId, requestId))
    .limit(1);
  return run ?? null;
}

function matches(row: CyberbizSalesRow, query: CyberbizSalesQuery): boolean {
  return (!query.sku || row.sku.toLowerCase() === query.sku.toLowerCase())
    && (!query.category || row.category.toLowerCase() === query.category.toLowerCase())
    && (!query.productName || row.productName.toLowerCase().includes(query.productName.toLowerCase()));
}

export function isCyberbizSalesDocument(value: unknown): value is CyberbizSalesDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<CyberbizSalesDocument>;
  return document.schemaVersion === 1
    && document.kind === "cyberbiz_sales_monthly"
    && (document.scopeType === "store" || document.scopeType === "company")
    && typeof document.scopeId === "string"
    && typeof document.reportMonth === "string"
    && document.granularity === "month"
    && Array.isArray(document.rows)
    && Boolean(document.totals && typeof document.totals === "object");
}

export function isCyberbizPayoutDocument(value: unknown): value is CyberbizPayoutDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<CyberbizPayoutDocument>;
  return document.schemaVersion === 1
    && document.kind === "cyberbiz_payout_daily"
    && (document.scopeType === "store" || document.scopeType === "company")
    && typeof document.scopeId === "string"
    && typeof document.reportMonth === "string"
    && document.granularity === "day"
    && Array.isArray(document.rows)
    && Boolean(document.totals && typeof document.totals === "object");
}

export function aggregateCyberbizSales(
  documents: readonly CyberbizSalesDocument[],
  query: CyberbizSalesQuery,
  manifest?: CyberbizReportManifest,
): CyberbizSalesQueryResult {
  const reportMonth = normalizeCyberbizMonth(query.reportMonth);
  const range = monthRange(reportMonth);
  if (!documents.length) {
    return {
      status: "NO_DATA_FOR_RANGE",
      reportMonth,
      requestedStart: range.start,
      requestedEnd: range.end,
      message: "指定月份沒有可用的 CYBERBIZ 銷售資料。",
    };
  }
  if (documents.some((document) => document.granularity !== "month")) {
    return {
      status: "UNSUPPORTED_GRANULARITY",
      reportMonth,
      requestedStart: range.start,
      requestedEnd: range.end,
      message: "目前銷售總表只有月彙總，不能回答日或任意日期區間。",
    };
  }
  if (documents.some((document) => document.coverageStart > range.start || document.coverageEnd < range.end)) {
    return {
      status: "INCOMPLETE_COVERAGE",
      reportMonth,
      requestedStart: range.start,
      requestedEnd: range.end,
      message: "指定月份的資料涵蓋不完整，不能回傳精確總額。",
    };
  }

  const bySku = new Map<string, CyberbizSalesRow>();
  for (const document of documents) {
    for (const row of document.rows.filter((candidate) => matches(candidate, query))) {
      const previous = bySku.get(row.sku);
      if (!previous) {
        bySku.set(row.sku, { ...row });
        continue;
      }
      previous.grossQuantity += row.grossQuantity;
      previous.returnQuantity += row.returnQuantity;
      previous.netQuantity += row.netQuantity;
      previous.salesAmount += row.salesAmount;
      if (row.costAmount !== undefined) previous.costAmount = (previous.costAmount ?? 0) + row.costAmount;
      if (row.grossProfit !== undefined) previous.grossProfit = (previous.grossProfit ?? 0) + row.grossProfit;
    }
  }
  const rows = [...bySku.values()].sort((left, right) => left.productName.localeCompare(right.productName, "zh-Hant"));
  return {
    status: "ok",
    reportMonth,
    scopeType: query.scopeType,
    ...(query.scopeId ? { scopeId: query.scopeId } : {}),
    ...(query.scopeName ? { scopeName: query.scopeName } : {}),
    rows,
    totals: rows.reduce((totals, row) => ({
      grossQuantity: totals.grossQuantity + row.grossQuantity,
      returnQuantity: totals.returnQuantity + row.returnQuantity,
      netQuantity: totals.netQuantity + row.netQuantity,
      salesAmount: totals.salesAmount + row.salesAmount,
    }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 }),
    ...(manifest ? { manifest: {
      id: manifest.id,
      reportMonth: manifest.reportMonth,
      reportKind: manifest.reportKind,
      scopeType: manifest.scopeType,
      scopeId: manifest.scopeId,
      scopeName: manifest.scopeName,
      coverageStart: manifest.coverageStart,
      coverageEnd: manifest.coverageEnd,
      sourceChecksum: manifest.sourceChecksum,
    } } : { manifest: {
      id: "untracked",
      reportMonth,
      reportKind: "sales",
      scopeType: query.scopeType,
      scopeId: query.scopeId ?? (query.scopeType === "company" ? "company" : ""),
      scopeName: query.scopeName ?? "",
      coverageStart: range.start,
      coverageEnd: range.end,
      sourceChecksum: "",
    } }),
  };
}

function payoutRowMatches(row: CyberbizPayoutRow, query: CyberbizPayoutQuery): boolean {
  return (!query.incomeType || row.incomeType === query.incomeType)
    && (!query.pos || row.pos === query.pos)
    && (!query.operator || row.operator === query.operator);
}

export function aggregateCyberbizPayout(
  documents: readonly CyberbizPayoutDocument[],
  query: CyberbizPayoutQuery,
  manifest?: CyberbizReportManifest,
): CyberbizPayoutQueryResult {
  const reportMonth = normalizeCyberbizMonth(query.reportMonth);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(query.endDate) || query.startDate > query.endDate) {
    return {
      status: "INCOMPLETE_COVERAGE",
      reportMonth,
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      message: "出金表查詢日期區間不正確。",
    };
  }
  if (!documents.length) {
    return {
      status: "NO_DATA_FOR_RANGE",
      reportMonth,
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      message: "指定區間沒有可用的 CYBERBIZ 出金資料。",
    };
  }
  if (documents.some((document) => document.granularity !== "day")) {
    return {
      status: "UNSUPPORTED_GRANULARITY",
      reportMonth,
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      message: "出金資料不是日粒度，無法精確回答指定區間。",
    };
  }
  if (documents.some((document) => document.coverageStart > query.startDate || document.coverageEnd < query.endDate)) {
    return {
      status: "INCOMPLETE_COVERAGE",
      reportMonth,
      requestedStart: query.startDate,
      requestedEnd: query.endDate,
      message: "指定區間的出金資料涵蓋不完整，不能回傳精確合計。",
    };
  }

  const rows = documents.flatMap((document) => document.rows)
    .filter((row) => row.date >= query.startDate && row.date <= query.endDate && payoutRowMatches(row, query));
  return {
    status: "ok",
    reportMonth,
    scopeType: query.scopeType,
    ...(query.scopeId ? { scopeId: query.scopeId } : {}),
    ...(query.scopeName ? { scopeName: query.scopeName } : {}),
    rows,
    totals: { incomeAmount: rows.reduce((total, row) => total + row.incomeAmount, 0), rowCount: rows.length },
    ...(manifest ? { manifest: {
      id: manifest.id,
      reportMonth: manifest.reportMonth,
      reportKind: manifest.reportKind,
      scopeType: manifest.scopeType,
      scopeId: manifest.scopeId,
      scopeName: manifest.scopeName,
      coverageStart: manifest.coverageStart,
      coverageEnd: manifest.coverageEnd,
      sourceChecksum: manifest.sourceChecksum,
    } } : { manifest: {
      id: "untracked",
      reportMonth,
      reportKind: "payout",
      scopeType: query.scopeType,
      scopeId: query.scopeId ?? (query.scopeType === "company" ? "company" : ""),
      scopeName: query.scopeName ?? "",
      coverageStart: query.startDate,
      coverageEnd: query.endDate,
      sourceChecksum: "",
    } }),
  };
}
