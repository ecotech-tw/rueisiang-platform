import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { findCyberbizReportRun, listCyberbizReportRuns, recordCyberbizReportRun } from "./cyberbiz-reports.js";
import { normalizeReportScopeName } from "./report-data.js";
import { scopes } from "./schema/reports.js";
import { cyberbizScopeIdFromStoreName } from "./scope-id.js";

/**
 * 出金表的店別與執行紀錄。
 *
 * 這裡不執行任何東西——真正的流程跑在 GitHub Actions 的 runner 上（開 Chrome、
 * 登 CYBERBIZ、讀 Gmail、寫 Drive）。平台只負責「有哪些店」「誰按過執行」，憑證
 * 一個都不碰；店別與報表匯入共用 target scopes／report_runs。
 */

export interface PayoutRun {
  id: string;
  requestId: string;
  storesJson: string;
  startDate: string;
  endDate: string;
  actorId: string;
  actorEmail: string;
  createdAt: string;
}

export interface PayoutStoreInput {
  name: string;
  /** CYBERBIZ 後台的店名，runner 拿它找店。空的時候沿用 name。 */
  externalName?: string;
  driveFolderUrl: string;
  driveFolderName: string;
  enabled: boolean;
}

export interface PayoutStore extends PayoutStoreInput {
  id: string;
  externalName: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 目前正式在跑的九家店。 */
export const DEFAULT_PAYOUT_STORES: PayoutStoreInput[] = [
  { name: "誠品西門店3F", driveFolderUrl: "https://drive.google.com/drive/folders/1WErhqB6jsTc2Gle4OXu7eoK2DRIoxrFG", driveFolderName: "誠品西門", enabled: true },
  { name: "宏匯廣場1F", driveFolderUrl: "https://drive.google.com/drive/folders/1o8r9R9EFSjVE1yYAVgTsv4luUFRaJ3Ao", driveFolderName: "宏匯", enabled: true },
  { name: "夢時代-7F", driveFolderUrl: "https://drive.google.com/drive/folders/1Hagb84o2O5OeCrrLfVke8YUStUtT2rMO", driveFolderName: "夢時代", enabled: true },
  { name: "台南新光西門", driveFolderUrl: "https://drive.google.com/drive/folders/14V5miPEkfB_ASpMZZKr4s0jlbyIX0h8O", driveFolderName: "台南新光", enabled: true },
  { name: "東山服務區", driveFolderUrl: "https://drive.google.com/drive/folders/11ofcZvX4nsBd6zuhy7ZsNAuRyDap9Z1Z", driveFolderName: "東山服務區", enabled: true },
  { name: "新營南服務區", driveFolderUrl: "https://drive.google.com/drive/folders/1AtX0v5xYVvVk2mk0t0ZnEYiqvm1o4uNZ", driveFolderName: "新營南服務區", enabled: true },
  { name: "仁德南服務區", driveFolderUrl: "https://drive.google.com/drive/folders/1FGdA9IQgq0kikVVfF3nOgedeoYDWAefu", driveFolderName: "仁德服務區", enabled: true },
  { name: "仁德北服務區", driveFolderUrl: "https://drive.google.com/drive/folders/1FGdA9IQgq0kikVVfF3nOgedeoYDWAefu", driveFolderName: "仁德服務區", enabled: true },
  { name: "品皇觀光工廠", driveFolderUrl: "https://drive.google.com/drive/folders/1238ahZoJjo_w481pJZ-2EyRfJ59bIESZ", driveFolderName: "品皇觀光工廠", enabled: true },
];

/**
 * runner 跑得動的店：CYBERBIZ 來源、還沒封存。
 *
 * 不再看 ID 前綴——手動上傳的退租店 source_type 就是 manual，用欄位判斷比用
 * 字串前綴可靠，而且改得動。
 */
function payoutScopeCondition(enabledOnly = false) {
  const runnableCyberbizStore = and(
    eq(scopes.sourceType, "cyberbiz"),
    eq(scopes.scopeKind, "store"),
    isNull(scopes.archivedAt),
  );
  return enabledOnly ? and(runnableCyberbizStore, eq(scopes.active, 1)) : runnableCyberbizStore;
}

function toPayoutStore(scope: typeof scopes.$inferSelect): PayoutStore {
  return {
    id: scope.id,
    name: scope.name,
    externalName: scope.externalName || scope.name,
    driveFolderUrl: scope.driveFolderUrl,
    driveFolderName: scope.driveFolderName,
    enabled: scope.active === 1,
    sortOrder: scope.sortOrder,
    createdAt: scope.createdAt,
    updatedAt: scope.updatedAt,
  };
}

export async function listPayoutStores(
  db: Database,
  options: { enabledOnly?: boolean } = {},
): Promise<PayoutStore[]> {
  const rows = await db.select().from(scopes)
    .where(payoutScopeCondition(options.enabledOnly))
    .orderBy(asc(scopes.sortOrder), asc(scopes.name));
  return rows.map(toPayoutStore);
}

/** 表是空的才寫入預設店別；使用者之後的設定不會被覆蓋。 */
export async function seedPayoutStores(db: Database): Promise<void> {
  const [existing] = await db.select({ id: scopes.id }).from(scopes)
    .where(payoutScopeCondition(false))
    .limit(1);
  if (existing) return;

  await db.insert(scopes).values(
    DEFAULT_PAYOUT_STORES.map((store, index) => ({
      id: cyberbizScopeIdFromStoreName(store.name),
      sourceType: "cyberbiz",
      scopeKind: "store" as const,
      name: store.name,
      normalizedName: normalizeReportScopeName(store.name),
      externalName: store.externalName ?? store.name,
      driveFolderUrl: store.driveFolderUrl,
      driveFolderName: store.driveFolderName,
      active: store.enabled ? 1 : 0,
      sortOrder: index,
    })),
  );
}

export async function recordPayoutRun(
  db: Database,
  input: {
    requestId: string;
    stores: string[];
    scopeIds?: string[];
    periodKind?: "month" | "custom";
    startDate: string;
    endDate: string;
    actor: { id: string; email: string };
  },
): Promise<void> {
  await recordCyberbizReportRun(db, {
    requestId: input.requestId,
    reportKind: "payout",
    periodKind: input.periodKind ?? "custom",
    stores: input.stores,
    scopeIds: input.scopeIds,
    startDate: input.startDate,
    endDate: input.endDate,
    actor: input.actor,
  });
}

function toPayoutRun(run: Awaited<ReturnType<typeof listCyberbizReportRuns>>[number]): PayoutRun {
  return {
    id: run.id,
    requestId: run.requestId,
    storesJson: run.storesJson,
    startDate: run.startDate,
    endDate: run.endDate,
    actorId: run.actorId,
    actorEmail: run.actorEmail,
    createdAt: run.createdAt,
  };
}

export async function listPayoutRuns(db: Database, limit = 20): Promise<PayoutRun[]> {
  const runs = await listCyberbizReportRuns(db, "payout", limit);
  return runs.map(toPayoutRun);
}

export async function findPayoutRun(db: Database, requestId: string): Promise<PayoutRun | null> {
  const run = await findCyberbizReportRun(db, requestId);
  return run?.reportKind === "payout" ? toPayoutRun(run) : null;
}
