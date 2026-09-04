import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { findCyberbizReportRun, listCyberbizReportRuns, recordCyberbizReportRun } from "./cyberbiz-reports.js";
import type { PayoutStore } from "./schema/tools.js";
import { payoutStores } from "./schema/tools.js";

/**
 * 出金表的店別與執行紀錄。
 *
 * 這裡不執行任何東西——真正的流程跑在 GitHub Actions 的 runner 上（開 Chrome、
 * 登 CYBERBIZ、讀 Gmail、寫 Drive）。平台只負責「有哪些店」「誰按過執行」，憑證
 * 一個都不碰；執行紀錄與報表匯入共用 target report_runs。
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
  driveFolderUrl: string;
  driveFolderName: string;
  enabled: boolean;
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

export async function listPayoutStores(
  db: Database,
  options: { enabledOnly?: boolean } = {},
): Promise<PayoutStore[]> {
  return db.select().from(payoutStores)
    .where(options.enabledOnly ? eq(payoutStores.enabled, true) : undefined)
    .orderBy(payoutStores.sortOrder, payoutStores.name);
}

/** 只切換平台上的顯示狀態；關掉的店不會出現在執行頁，也不會被送給 runner。 */
export async function updatePayoutStoreEnabled(
  db: Database,
  input: { id: string; enabled: boolean },
): Promise<PayoutStore | null> {
  await db.update(payoutStores)
    .set({ enabled: input.enabled, updatedAt: new Date().toISOString() })
    .where(eq(payoutStores.id, input.id));
  const [store] = await db.select().from(payoutStores).where(eq(payoutStores.id, input.id)).limit(1);
  return store ?? null;
}

export async function savePayoutStore(
  db: Database,
  input: PayoutStoreInput & { id?: string },
): Promise<PayoutStore | null> {
  const now = new Date().toISOString();
  const id = input.id ?? crypto.randomUUID();

  if (input.id) {
    const [existing] = await db.select({ id: payoutStores.id }).from(payoutStores)
      .where(eq(payoutStores.id, id)).limit(1);
    if (!existing) return null;

    await db.update(payoutStores)
      .set({
        name: input.name,
        driveFolderUrl: input.driveFolderUrl,
        driveFolderName: input.driveFolderName,
        enabled: input.enabled,
        updatedAt: now,
      })
      .where(eq(payoutStores.id, id));
  } else {
    const [last] = await db.select({ sortOrder: payoutStores.sortOrder }).from(payoutStores)
      .orderBy(desc(payoutStores.sortOrder)).limit(1);
    await db.insert(payoutStores).values({
      id,
      name: input.name,
      driveFolderUrl: input.driveFolderUrl,
      driveFolderName: input.driveFolderName,
      enabled: input.enabled,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    });
  }

  const [store] = await db.select().from(payoutStores)
    .where(eq(payoutStores.id, id)).limit(1);
  return store ?? null;
}

export async function deletePayoutStore(db: Database, id: string): Promise<PayoutStore | null> {
  const [store] = await db.select().from(payoutStores).where(eq(payoutStores.id, id)).limit(1);
  if (!store) return null;

  await db.delete(payoutStores).where(eq(payoutStores.id, id));
  return store;
}

/** 表是空的才寫入預設店別；使用者之後的設定不會被覆蓋。 */
export async function seedPayoutStores(db: Database): Promise<void> {
  const [existing] = await db.select({ id: payoutStores.id }).from(payoutStores).limit(1);
  if (existing) return;

  await db.insert(payoutStores).values(
    DEFAULT_PAYOUT_STORES.map((store, index) => ({
      id: crypto.randomUUID(),
      ...store,
      sortOrder: index,
    })),
  );
}

/** 整份店別清單換掉；執行紀錄只連結 target scope，不依賴 payout store 的 id。 */
export async function replacePayoutStores(db: Database, stores: PayoutStoreInput[]): Promise<void> {
  await db.batch([
    db.delete(payoutStores),
    db.insert(payoutStores).values(
      stores.map((store, index) => ({
        id: crypto.randomUUID(),
        ...store,
        sortOrder: index,
      })),
    ),
  ]);
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
