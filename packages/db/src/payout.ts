import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
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

function payoutScopeIdCondition(scopeId: string) {
  return and(eq(scopes.id, scopeId), payoutScopeCondition(false));
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

/** 只切換平台上的顯示狀態；關掉的店不會出現在執行頁，也不會被送給 runner。 */
export async function updatePayoutStoreEnabled(
  db: Database,
  input: { id: string; enabled: boolean },
): Promise<PayoutStore | null> {
  await db.update(scopes)
    .set({ active: input.enabled ? 1 : 0, updatedAt: new Date().toISOString() })
    .where(payoutScopeIdCondition(input.id));
  const [store] = await db.select().from(scopes).where(payoutScopeIdCondition(input.id)).limit(1);
  return store ? toPayoutStore(store) : null;
}

export async function savePayoutStore(
  db: Database,
  input: PayoutStoreInput & { id?: string },
): Promise<PayoutStore | null> {
  const now = new Date().toISOString();
  const id = input.id ?? cyberbizScopeIdFromStoreName(input.name);

  if (input.id) {
    const [existing] = await db.select({ id: scopes.id }).from(scopes)
      .where(payoutScopeIdCondition(id))
      .limit(1);
    if (!existing) return null;

    await db.update(scopes)
      .set({
        name: input.name,
        normalizedName: normalizeReportScopeName(input.name),
        externalName: input.externalName ?? input.name,
        driveFolderUrl: input.driveFolderUrl,
        driveFolderName: input.driveFolderName,
        active: input.enabled ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(scopes.id, id));
  } else {
    const [last] = await db.select({ sortOrder: scopes.sortOrder }).from(scopes)
      .where(payoutScopeCondition(false))
      .orderBy(desc(scopes.sortOrder))
      .limit(1);
    await db.insert(scopes).values({
      id,
      sourceType: "cyberbiz",
      scopeKind: "store",
      name: input.name,
      normalizedName: normalizeReportScopeName(input.name),
      externalName: input.externalName ?? input.name,
      driveFolderUrl: input.driveFolderUrl,
      driveFolderName: input.driveFolderName,
      active: input.enabled ? 1 : 0,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  const [store] = await db.select().from(scopes)
    .where(payoutScopeIdCondition(id)).limit(1);
  return store ? toPayoutStore(store) : null;
}

/**
 * 封存，不刪除。
 *
 * 出金、商品銷售、報表執行與人事指派都用 scope_id 指著這一列；真的刪掉，那些
 * 歷史就變成查不到來源的孤兒。原本的作法是「沒被引用才真刪」，但使用者按下去
 * 之前不知道自己會拿到哪一種結果。
 */
export async function archivePayoutStore(db: Database, id: string): Promise<PayoutStore | null> {
  const [store] = await db.select().from(scopes)
    .where(payoutScopeIdCondition(id))
    .limit(1);
  if (!store) return null;

  const now = new Date().toISOString();
  await db.update(scopes).set({ active: 0, archivedAt: now, updatedAt: now }).where(eq(scopes.id, id));
  return { ...toPayoutStore(store), enabled: false };
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

/** 整份店別清單換掉；清單裡沒有的一律封存，不刪除。 */
export async function replacePayoutStores(db: Database, stores: PayoutStoreInput[]): Promise<void> {
  const normalizedNames = stores.map((store) => normalizeReportScopeName(store.name));
  const existing = await db.select().from(scopes)
    .where(payoutScopeCondition(false));
  const incomingByName = new Map(stores.map((store, index) => [normalizeReportScopeName(store.name), { store, index }]));

  const statements = [];
  for (const scope of existing) {
    const incoming = incomingByName.get(scope.normalizedName);
    if (incoming) {
      statements.push(db.update(scopes).set({
        name: incoming.store.name,
        normalizedName: normalizeReportScopeName(incoming.store.name),
        externalName: incoming.store.externalName ?? incoming.store.name,
        driveFolderUrl: incoming.store.driveFolderUrl,
        driveFolderName: incoming.store.driveFolderName,
        active: incoming.store.enabled ? 1 : 0,
        sortOrder: incoming.index,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(scopes.id, scope.id)));
    }
  }

  if (normalizedNames.length) {
    const removed = existing.filter((scope) => !normalizedNames.includes(scope.normalizedName));
    for (const scope of removed) {
      statements.push(db.update(scopes)
        .set({ active: 0, archivedAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(scopes.id, scope.id)));
    }
  }

  const existingNames = new Set(existing.map((scope) => scope.normalizedName));
  statements.push(...stores.flatMap((store, index) => {
    const normalizedName = normalizeReportScopeName(store.name);
    if (existingNames.has(normalizedName)) return [];
    return [db.insert(scopes).values({
      id: cyberbizScopeIdFromStoreName(store.name),
      sourceType: "cyberbiz",
      scopeKind: "store" as const,
      name: store.name,
      normalizedName,
      externalName: store.externalName ?? store.name,
      driveFolderUrl: store.driveFolderUrl,
      driveFolderName: store.driveFolderName,
      active: store.enabled ? 1 : 0,
      sortOrder: index,
    })];
  }));

  if (statements.length) await db.batch(statements as never);
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
