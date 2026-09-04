import { eq, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { items as itemMasters } from "./schema/items.js";
import { cyberbizProductLinks, inventoryItems, wmsCyberbizLinks, wmsItems } from "./schema/wms.js";
import { WmsError } from "./wms.js";

/**
 * WMS 與 CYBERBIZ 的庫存對帳。
 *
 * 這個檔案只做「比對與寫入本地」，不跟官網講話——官網那一段在
 * packages/cyberbiz 的 inventory.ts。分開的理由跟 CRM 一樣：比對邏輯要能單獨
 * 測，而測它不該需要一個假的 HTTP 伺服器。
 *
 * **三條不變條件**（從舊系統的 cyberbiz-wms-sync-plan.ts 帶過來，每一條都是
 * 對錯資料的防線）：
 *
 * 1. 官網找不到那個款式 → 標記失敗，不寫數量。
 * 2. product_id 對不上 → 連結失效，不寫數量。
 * 3. SKU 對不上 → 連結失效，不寫數量。
 *
 * 三條的共同點是：**寧可讓這一筆停在「同步失敗」，也不要把數量寫到錯的商品上。**
 * 寫錯的話沒有人看得出來，倉庫的人會照著一個錯的數字去撿貨。
 */

/** 一筆連結，加上它目前在 WMS 這邊的數量。 */
export interface LinkedItem {
  linkId: string;
  inventoryItemId: string;
  cyberbizProductId: string;
  cyberbizVariantId: string;
  linkedSku: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  minStock: number;
}

/** 官網那邊的同一個款式。只取比對與寫入會用到的欄位。 */
export interface RemoteItem {
  productId: string;
  variantId: string;
  sku: string;
  quantity: number;
  safetyQuantity: number;
}

export interface SyncPlanEntry {
  link: LinkedItem;
  remote: RemoteItem | null;
  status: "synced" | "failed";
  error: string;
  quantityChanged: boolean;
  minStockChanged: boolean;
}

const normalizedSku = (value: string) => value.trim().toUpperCase();

async function useTargetLinks(db: Database): Promise<boolean> {
  const row = await db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cyberbiz_product_links' LIMIT 1`);
  return !row;
}

/**
 * 決定每一筆連結該怎麼處理。純函式，沒有 I/O——所以「連結失效時會不會誤寫數量」
 * 這種問題可以直接測，不必架一個假的官網。
 */
export function buildSyncPlan(links: LinkedItem[], remotes: RemoteItem[]): SyncPlanEntry[] {
  const byVariant = new Map(remotes.map((item) => [item.variantId, item]));

  return links.map((link) => {
    const remote = byVariant.get(link.cyberbizVariantId) ?? null;
    let error = "";

    if (!remote) error = "CYBERBIZ 找不到已連結的商品款式";
    else if (remote.productId !== link.cyberbizProductId) error = "CYBERBIZ 商品連結已失效：product_id 不一致";
    else if (normalizedSku(remote.sku) !== normalizedSku(link.linkedSku)) {
      error = "CYBERBIZ 商品連結已失效：SKU 不一致";
    }

    return {
      link,
      remote,
      status: error ? "failed" : "synced",
      error,
      // 失敗的一律不算「有變更」，免得呼叫端照著它去寫。
      quantityChanged: !error && remote !== null && remote.quantity !== link.quantity,
      minStockChanged: !error && remote !== null && remote.safetyQuantity !== link.minStock,
    };
  });
}

/** 讀出所有公司倉的連結，附上 WMS 這邊目前的數量。 */
export async function listCompanyLinks(db: Database, productId?: string): Promise<LinkedItem[]> {
  if (await useTargetLinks(db)) {
    return db
      .select({
        linkId: wmsCyberbizLinks.id,
        inventoryItemId: wmsCyberbizLinks.wmsItemId,
        cyberbizProductId: wmsCyberbizLinks.cyberbizProductId,
        cyberbizVariantId: wmsCyberbizLinks.cyberbizVariantId,
        linkedSku: sql<string>`${wmsCyberbizLinks.sku}`.as("linked_sku"),
        itemSku: itemMasters.sku,
        itemName: itemMasters.name,
        quantity: wmsItems.quantity,
        minStock: wmsItems.minStock,
      })
      .from(wmsCyberbizLinks)
      .innerJoin(wmsItems, eq(wmsItems.itemId, wmsCyberbizLinks.wmsItemId))
      .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
      .where(
        productId
          ? sql`${wmsCyberbizLinks.warehouseScope} = 'company' AND ${wmsCyberbizLinks.cyberbizProductId} = ${productId}`
          : sql`${wmsCyberbizLinks.warehouseScope} = 'company'`,
      );
  }

  const rows = await db
    .select({
      linkId: cyberbizProductLinks.id,
      inventoryItemId: cyberbizProductLinks.inventoryItemId,
      cyberbizProductId: cyberbizProductLinks.cyberbizProductId,
      cyberbizVariantId: cyberbizProductLinks.cyberbizVariantId,
      /*
       * 兩張表都有 sku 欄位，直接選會有兩個同名的輸出欄——回來的結果對映會錯位
       * （測試抓到的：quantity 拿到 minStock 的值、minStock 變成 undefined）。
       * 明確取別名，讓輸出的欄名不重複。
       */
      linkedSku: sql<string>`${cyberbizProductLinks.sku}`.as("linked_sku"),
      itemSku: sql<string>`COALESCE(${inventoryItems.sku}, '')`.as("item_sku"),
      itemName: inventoryItems.name,
      quantity: inventoryItems.quantity,
      minStock: inventoryItems.minStock,
    })
    .from(cyberbizProductLinks)
    .innerJoin(inventoryItems, eq(inventoryItems.id, cyberbizProductLinks.inventoryItemId))
    .where(
      productId
        ? sql`${cyberbizProductLinks.warehouseScope} = 'company' AND ${cyberbizProductLinks.cyberbizProductId} = ${productId}`
        : sql`${cyberbizProductLinks.warehouseScope} = 'company'`,
    );

  return rows;
}

export interface SyncOutcome {
  updated: number;
  unchanged: number;
  failed: number;
}

function updateLink(
  db: Database,
  target: boolean,
  linkId: string,
  values: Record<string, unknown>,
) {
  return (target ? db.update(wmsCyberbizLinks) : db.update(cyberbizProductLinks))
    .set(values as never)
    .where(eq(target ? wmsCyberbizLinks.id : cyberbizProductLinks.id, linkId));
}

function updateLinkedItem(
  db: Database,
  target: boolean,
  itemId: string,
  values: Record<string, unknown>,
) {
  return (target ? db.update(wmsItems) : db.update(inventoryItems))
    .set(values as never)
    .where(eq(target ? wmsItems.itemId : inventoryItems.id, itemId));
}

/**
 * 把計畫套用到 WMS。
 *
 * **官網是庫存數量的真相來源**，跟 CRM 的客戶資料一樣——所以這裡是把官網的數量
 * 寫進 WMS，不是反過來。反過來的那條路是盤點（人數完之後推上去），走的是
 * inventory.ts 的 setCompanyQuantity。
 *
 * 每一筆數量變動都寫一筆操作紀錄。批次同步可能一次改幾十筆，但那些正是之後
 * 「這個數字為什麼變了」要查的東西——省下來的話就查不到了。
 */
export async function applySyncPlan(
  db: Database,
  plan: SyncPlanEntry[],
  /*
   * 沒有人按的時候給 null——webhook 就是這種。activityRow 會把它記成 system，
   * 操作紀錄那一頁顯示「系統」而不是一個空白的 email。
   */
  actor: { id?: string | null; email?: string | null } | null,
): Promise<SyncOutcome> {
  const syncedAt = new Date().toISOString();
  const target = await useTargetLinks(db);
  /*
   * drizzle 的 batch 要求「至少一句」的 tuple 型別，收集階段給不出來（可能是空的），
   * 所以這裡先當成一般陣列，送出去之前才在有內容的分支斷言。
   */
  type Statement = Parameters<Database["batch"]>[0][number];
  const statements: Statement[] = [];
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const entry of plan) {
    const label = entry.link.itemSku ? `${entry.link.itemSku} ${entry.link.itemName}` : entry.link.itemName;

    if (entry.status === "failed" || !entry.remote) {
      failed += 1;
      statements.push(
        updateLink(db, target, entry.link.linkId, { syncStatus: "failed", lastError: entry.error, updatedAt: sql`CURRENT_TIMESTAMP` }),
        db.insert(activityEvents).values(
          activityRow({
            entityType: "inventory_item",
            entityId: entry.link.inventoryItemId,
            entityLabel: label,
            eventType: "cyberbiz_sync_failed",
            summary: entry.error,
            source: "cyberbiz_sync",
            status: "failed",
            error: entry.error,
            actor,
          }),
        ),
      );
      continue;
    }

    if (!entry.quantityChanged && !entry.minStockChanged) {
      unchanged += 1;
      statements.push(
        updateLink(db, target, entry.link.linkId, {
          syncStatus: "synced",
          lastError: "",
          lastSyncedQuantity: entry.remote.quantity,
          lastSyncedAt: syncedAt,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        }),
      );
      continue;
    }

    updated += 1;
    statements.push(
      updateLinkedItem(db, target, entry.link.inventoryItemId, {
        quantity: entry.remote.quantity,
        minStock: entry.remote.safetyQuantity,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }),
      updateLink(db, target, entry.link.linkId, {
        syncStatus: "synced",
        lastError: "",
        lastSyncedQuantity: entry.remote.quantity,
        lastSyncedAt: syncedAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }),
      db.insert(activityEvents).values(
        activityRow({
          entityType: "inventory_item",
          entityId: entry.link.inventoryItemId,
          entityLabel: label,
          eventType: "cyberbiz_synced",
          summary: entry.quantityChanged ? "從 CYBERBIZ 同步庫存數量" : "從 CYBERBIZ 同步安全庫存",
          field: entry.quantityChanged ? "quantity" : "minStock",
          oldValue: String(entry.quantityChanged ? entry.link.quantity : entry.link.minStock),
          newValue: String(entry.quantityChanged ? entry.remote.quantity : entry.remote.safetyQuantity),
          source: "cyberbiz_sync",
          actor,
        }),
      ),
    );
  }

  /*
   * D1 的 batch 有語句數量上限，而且一次送太多會逼近 Worker 的執行時間。
   * 分批送，每批之間是獨立的交易——中途失敗的話前面幾批已經寫進去了，
   * 那沒關係：同步本來就是可以重跑的，重跑一次會把剩下的補完。
   */
  const BATCH = 50;
  for (let index = 0; index < statements.length; index += BATCH) {
    const slice = statements.slice(index, index + BATCH);
    if (slice.length) await db.batch(slice as [Statement, ...Statement[]]);
  }

  return { updated, unchanged, failed };
}

/** 建立一筆商品連結。品項與款式都是一對一，撞到就是重複連結。 */
export async function linkItemToCyberbiz(
  db: Database,
  input: {
    inventoryItemId: string;
    productId: string;
    variantId: string;
    sku: string;
    quantity: number;
    actor: { id: string; email: string };
  },
) {
  const target = await useTargetLinks(db);
  const [item] = target
    ? await db.select({ sku: itemMasters.sku, name: itemMasters.name }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, input.inventoryItemId))
    : await db.select({ sku: inventoryItems.sku, name: inventoryItems.name }).from(inventoryItems).where(eq(inventoryItems.id, input.inventoryItemId));
  if (!item) throw new WmsError("not_found", "找不到這項商品。");

  const id = crypto.randomUUID();
  const link = {
    id,
    cyberbizProductId: input.productId,
    cyberbizVariantId: input.variantId,
    sku: input.sku.trim().toUpperCase(),
    warehouseScope: "company" as const,
    syncStatus: "synced" as const,
    lastSyncedQuantity: input.quantity,
    lastSyncedAt: new Date().toISOString(),
  };
  await db.batch([
    target
      ? db.insert(wmsCyberbizLinks).values({ ...link, wmsItemId: input.inventoryItemId })
      : db.insert(cyberbizProductLinks).values({ ...link, inventoryItemId: input.inventoryItemId }),
    db.insert(activityEvents).values(
      activityRow({
        entityType: "inventory_item",
        entityId: input.inventoryItemId,
        entityLabel: item.sku ? `${item.sku} ${item.name}` : item.name,
        eventType: "cyberbiz_linked",
        summary: `連結 CYBERBIZ 款式 ${input.variantId}`,
        source: "cyberbiz_sync",
        actor: input.actor,
      }),
    ),
  ] as never);

  return { id };
}

/**
 * 解除連結。
 *
 * 只刪連結，**不動 WMS 的數量**——那些貨還在架上。解除連結的意思是「以後不再
 * 跟官網對帳」，不是「這些東西不見了」。
 */
export async function unlinkItemFromCyberbiz(
  db: Database,
  inventoryItemId: string,
  actor: { id: string; email: string },
) {
  const target = await useTargetLinks(db);
  const [item] = target
    ? await db.select({ sku: itemMasters.sku, name: itemMasters.name }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, inventoryItemId))
    : await db.select({ sku: inventoryItems.sku, name: inventoryItems.name }).from(inventoryItems).where(eq(inventoryItems.id, inventoryItemId));
  if (!item) throw new WmsError("not_found", "找不到這項商品。");

  await db.batch([
    target
      ? db.delete(wmsCyberbizLinks).where(eq(wmsCyberbizLinks.wmsItemId, inventoryItemId))
      : db.delete(cyberbizProductLinks).where(eq(cyberbizProductLinks.inventoryItemId, inventoryItemId)),
    db.insert(activityEvents).values(
      activityRow({
        entityType: "inventory_item",
        entityId: inventoryItemId,
        entityLabel: item.sku ? `${item.sku} ${item.name}` : item.name,
        eventType: "cyberbiz_unlinked",
        summary: "解除 CYBERBIZ 連結（庫存數量保留）",
        source: "cyberbiz_sync",
        actor,
      }),
    ),
  ] as never);
}

/**
 * 盤點推上官網成功之後，把連結標成已同步。
 *
 * 不寫操作紀錄：盤點本身已經記了一筆（誰、什麼時候、從幾改到幾），再記一次
 * 「已同步」只是同一件事的兩行。失敗才值得單獨記——那是需要有人處理的狀態。
 */
export async function markLinkSynced(db: Database, linkId: string, quantity: number): Promise<void> {
  await updateLink(db, await useTargetLinks(db), linkId, {
    syncStatus: "synced",
    lastError: "",
    lastSyncedQuantity: quantity,
    lastSyncedAt: new Date().toISOString(),
    updatedAt: sql`CURRENT_TIMESTAMP`,
  });
}

/**
 * 推不上官網。連結標成失敗，並且留一筆紀錄。
 *
 * 這一筆很重要：盤點成功了、官網沒跟上，本地與官網從此不一致。沒有紀錄的話
 * 沒有人知道要回頭處理，而畫面上兩邊都顯示「有數字」，看起來一切正常。
 */
export async function markLinkFailed(
  db: Database,
  linkId: string,
  error: string,
  context: { inventoryItemId: string; label: string; actor: { id: string; email: string } },
): Promise<void> {
  await db.batch([
    updateLink(db, await useTargetLinks(db), linkId, { syncStatus: "failed", lastError: error, updatedAt: sql`CURRENT_TIMESTAMP` }),
    db.insert(activityEvents).values(
      activityRow({
        entityType: "inventory_item",
        entityId: context.inventoryItemId,
        entityLabel: context.label,
        eventType: "cyberbiz_sync_failed",
        summary: "盤點已存，但沒有推上 CYBERBIZ",
        source: "cyberbiz_sync",
        status: "failed",
        error,
        actor: context.actor,
      }),
    ),
  ] as never);
}
