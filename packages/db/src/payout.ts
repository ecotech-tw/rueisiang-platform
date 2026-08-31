import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { payoutRuns, payoutStores, type PayoutStore } from "./schema/tools.js";

/**
 * 出金表的店別與執行紀錄。
 *
 * 這裡不執行任何東西——真正的流程跑在 GitHub Actions 的 runner 上（開 Chrome、
 * 登 CYBERBIZ、讀 Gmail、寫 Drive）。平台只負責「有哪些店」「誰按了執行」，
 * 憑證一個都不碰。
 */

export interface PayoutStoreInput {
  name: string;
  driveFolderUrl: string;
  driveFolderName: string;
  enabled: boolean;
}

/**
 * 目前正式在跑的九家店，與帳務 repo 的 stores.json 一致。
 *
 * 寫在程式碼裡是為了讓新環境（或本機 dev）一開起來就有東西可看——空清單會讓
 * 執行頁整片空白，然後有人要手動把九組 Drive 連結重打一次。只在表是空的時候
 * 寫入，之後就以資料庫為準：這是起點，不是每次都覆蓋回去的來源。
 */
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

/** 只切換平台上的顯示狀態；runner 的 stores.json 不需要跟著改。 */
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

/**
 * 表是空的才寫入預設店別，已經有資料就完全不動。
 *
 * 跟 syncSystemRoles 放在一起被呼叫，但語意刻意不同：角色權限是程式碼說了算、
 * 每次重寫；店別是同仁自己維護的資料，覆蓋回去會把人家的修改抹掉。
 */
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

/**
 * 整份店別清單換掉。
 *
 * 逐筆比對再決定新增／修改／刪除，只是為了保住 id 而寫的一堆分支——這張表沒有
 * 任何東西用 id 指過來（執行紀錄存的是店名字串），整組重寫既簡單又不會漏。
 */
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
    startDate: string;
    endDate: string;
    actor: { id: string; email: string };
  },
): Promise<void> {
  await db.insert(payoutRuns).values({
    id: crypto.randomUUID(),
    requestId: input.requestId,
    storesJson: JSON.stringify(input.stores),
    startDate: input.startDate,
    endDate: input.endDate,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
  });
}

export async function listPayoutRuns(db: Database, limit = 20) {
  return db.select().from(payoutRuns).orderBy(desc(payoutRuns.createdAt)).limit(limit);
}

export async function findPayoutRun(db: Database, requestId: string) {
  const [row] = await db
    .select()
    .from(payoutRuns)
    .where(eq(payoutRuns.requestId, requestId))
    .limit(1);
  return row ?? null;
}
