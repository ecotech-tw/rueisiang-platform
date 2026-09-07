import type { CyberbizInventoryClient } from "@rueisiang/cyberbiz";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { cyberbizProducts, items as itemMasters } from "./schema/items.js";
import { activityEvents } from "./schema/activity.js";
import { cyberbizSyncLocks, wmsItems } from "./schema/wms.js";
import { WmsError } from "./wms.js";

/** WMS 裡實際有庫存、而且在 CYBERBIZ 有外部身分的品項。 */
export interface LinkedItem {
  /** target wms_items.item_id；保留既有 API 欄位名稱。 */
  inventoryItemId: string;
  cyberbizProductId: string;
  cyberbizVariantId: string;
  /** items.sku 是全平台唯一，也是 CYBERBIZ 款式的 SKU。 */
  linkedSku: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  minStock: number;
  /** 用來拒絕較早讀取的 remote snapshot 覆蓋較新的本地盤點。 */
  updatedAt?: string;
}

export interface RemoteItem {
  productId: string;
  variantId: string;
  sku: string;
  quantity: number;
  safetyQuantity: number;
  /** 有值代表門市庫存；WMS 只接受公司倉。測試中的最小 fixture 可省略。 */
  posShopId?: string;
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

export function buildSyncPlan(links: LinkedItem[], remotes: RemoteItem[]): SyncPlanEntry[] {
  const byVariant = new Map(
    remotes
      .filter((item) => !item.posShopId)
      .map((item) => [item.variantId, item]),
  );
  return links.map((link) => {
    const remote = byVariant.get(link.cyberbizVariantId) ?? null;
    let error = "";
    if (!remote) error = "CYBERBIZ 找不到已連結的商品款式";
    else if (remote.productId !== link.cyberbizProductId) error = "CYBERBIZ 商品連結已失效：product_id 不一致";
    else if (normalizedSku(remote.sku) !== normalizedSku(link.linkedSku)) error = "CYBERBIZ 商品連結已失效：SKU 不一致";
    return {
      link, remote, status: error ? "failed" : "synced", error,
      quantityChanged: !error && remote !== null && remote.quantity !== link.quantity,
      minStockChanged: !error && remote !== null && remote.safetyQuantity !== link.minStock,
    };
  });
}

/**
 * target schema 沒有另一張 WMS-CYBERBIZ link 表。
 *
 * wms_items 表示「這個 item 進了倉庫」，cyberbiz_products 表示「這個 item
 * 在官網的身分」；兩張延伸表都用 items.id，所以 join 本身就是連結。
 */
export async function listCompanyLinks(
  db: Database,
  options: { productId?: string; inventoryItemId?: string } = {},
): Promise<LinkedItem[]> {
  const filters = [eq(cyberbizProducts.itemId, wmsItems.itemId)];
  if (options.productId) filters.push(eq(cyberbizProducts.cyberbizProductId, options.productId));
  if (options.inventoryItemId) filters.push(eq(wmsItems.itemId, options.inventoryItemId));

  const rows = await db.select({
    inventoryItemId: wmsItems.itemId,
    cyberbizProductId: cyberbizProducts.cyberbizProductId,
    cyberbizVariantId: cyberbizProducts.cyberbizVariantId,
    item: {
      sku: itemMasters.sku,
      name: itemMasters.name,
    },
    wms: {
      quantity: wmsItems.quantity,
      minStock: wmsItems.minStock,
      updatedAt: wmsItems.updatedAt,
    },
  })
    .from(wmsItems)
    .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
    .innerJoin(cyberbizProducts, eq(cyberbizProducts.itemId, wmsItems.itemId))
    .where(and(...filters));

  return rows.map((row) => ({
    inventoryItemId: row.inventoryItemId,
    cyberbizProductId: row.cyberbizProductId,
    cyberbizVariantId: row.cyberbizVariantId,
    linkedSku: row.item.sku,
    itemSku: row.item.sku,
    itemName: row.item.name,
    quantity: row.wms.quantity,
    minStock: row.wms.minStock,
    updatedAt: row.wms.updatedAt,
  }));
}

export interface SyncOutcome { updated: number; unchanged: number; failed: number }

const CYBERBIZ_SYNC_LEASE_SECONDS = 120;

/** 以 D1 原子 INSERT/UPDATE 取得外部差額 API 的 item lease。 */
export async function claimCyberbizSyncLock(
  db: Database,
  itemId: string,
  leaseSeconds = CYBERBIZ_SYNC_LEASE_SECONDS,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const seconds = Math.max(30, Math.trunc(leaseSeconds));
  const inserted = await db.insert(cyberbizSyncLocks).values({
    itemId,
    token,
    leaseUntil: sql`datetime('now', ${`+${seconds} seconds`})`,
  }).onConflictDoNothing();
  if ((inserted.meta?.changes ?? 0) > 0) return token;

  const renewed = await db.update(cyberbizSyncLocks).set({
    token,
    leaseUntil: sql`datetime('now', ${`+${seconds} seconds`})`,
  }).where(and(
    eq(cyberbizSyncLocks.itemId, itemId),
    sql`${cyberbizSyncLocks.leaseUntil} <= CURRENT_TIMESTAMP`,
  ));
  return (renewed.meta?.changes ?? 0) > 0 ? token : null;
}

export async function releaseCyberbizSyncLock(
  db: Database,
  itemId: string,
  token: string,
): Promise<void> {
  await db.delete(cyberbizSyncLocks).where(and(
    eq(cyberbizSyncLocks.itemId, itemId),
    eq(cyberbizSyncLocks.token, token),
  ));
}

async function setCyberbizProductSyncStatus(
  db: Database,
  itemId: string,
  status: "synced" | "failed",
): Promise<void> {
  await db.update(cyberbizProducts).set({
    syncStatus: status,
    ...(status === "synced" ? { syncedAt: sql`CURRENT_TIMESTAMP` } : {}),
  }).where(eq(cyberbizProducts.itemId, itemId));
}

function updateLinkedItem(
  db: Database,
  link: LinkedItem,
  values: Record<string, unknown>,
) {
  const snapshot = and(
    eq(wmsItems.quantity, link.quantity),
    eq(wmsItems.minStock, link.minStock),
    ...(link.updatedAt ? [eq(wmsItems.updatedAt, link.updatedAt)] : []),
  );
  return db.update(wmsItems)
    .set(values as never)
    .where(and(eq(wmsItems.itemId, link.inventoryItemId), snapshot));
}

export async function applySyncPlan(
  db: Database,
  plan: SyncPlanEntry[],
  actor: { id?: string | null; email?: string | null } | null,
): Promise<SyncOutcome> {
  let updated = 0;
  let unchanged = 0;
  let failed = 0;
  for (const entry of plan) {
    const label = entry.link.itemSku ? `${entry.link.itemSku} ${entry.link.itemName}` : entry.link.itemName;
    if (entry.status === "failed" || !entry.remote) {
      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "failed");
      failed += 1;
      await db.insert(activityEvents).values(activityRow({
        entityType: "item",
        entityId: entry.link.inventoryItemId,
        entityLabel: label,
        eventType: "cyberbiz_sync_failed",
        summary: entry.error,
        source: "cyberbiz_sync",
        status: "failed",
        error: entry.error,
        actor,
      }));
      continue;
    }

    if (!entry.quantityChanged && !entry.minStockChanged) {
      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "synced");
      unchanged += 1;
      // 即使數字沒有變，也要留下最後一次成功同步時間；這是 target model
      // 唯一不複製另一份 sync timestamp 的做法。
      await db.insert(activityEvents).values(activityRow({
        entityType: "item",
        entityId: entry.link.inventoryItemId,
        entityLabel: label,
        eventType: "cyberbiz_synced",
        summary: "CYBERBIZ 同步完成（數量未變）",
        field: "sync",
        newValue: `${entry.remote.quantity}/${entry.remote.safetyQuantity}`,
        source: "cyberbiz_sync",
        actor,
      }));
      continue;
    }

    // updated_at 是 compare-and-set：若 manual count 或另一個 webhook 已先改過
    // 本地資料，這筆舊 snapshot 只能失敗並等下一次同步，不能把新值覆蓋掉。
    // 另外先取得同一把 lease，讓盤點 route 不會在 CAS 後立刻把官網推送覆蓋掉。
    const lockToken = await claimCyberbizSyncLock(db, entry.link.inventoryItemId);
    if (!lockToken) {
      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "failed");
      const error = "WMS 商品正在同步中，這筆 CYBERBIZ 數量稍後重試";
      failed += 1;
      await db.insert(activityEvents).values(activityRow({
        entityType: "item",
        entityId: entry.link.inventoryItemId,
        entityLabel: label,
        eventType: "cyberbiz_sync_failed",
        summary: error,
        source: "cyberbiz_sync",
        status: "failed",
        error,
        actor,
      }));
      continue;
    }

    try {
      const result = await updateLinkedItem(db, entry.link, {
        quantity: entry.remote.quantity,
        minStock: entry.remote.safetyQuantity,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      });
      if ((result.meta?.changes ?? 0) === 0) {
        await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "failed");
        const error = "WMS 數量在同步期間已被其他操作修改，拒絕覆蓋較新的資料";
        failed += 1;
        await db.insert(activityEvents).values(activityRow({
          entityType: "item",
          entityId: entry.link.inventoryItemId,
          entityLabel: label,
          eventType: "cyberbiz_sync_failed",
          summary: error,
          source: "cyberbiz_sync",
          status: "failed",
          error,
          actor,
        }));
        continue;
      }

      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "synced");
      updated += 1;
      await db.insert(activityEvents).values(activityRow({
        entityType: "item",
        entityId: entry.link.inventoryItemId,
        entityLabel: label,
        eventType: "cyberbiz_synced",
        summary: entry.quantityChanged ? "從 CYBERBIZ 同步庫存數量" : "從 CYBERBIZ 同步安全庫存",
        field: entry.quantityChanged ? "quantity" : "minStock",
        oldValue: String(entry.quantityChanged ? entry.link.quantity : entry.link.minStock),
        newValue: String(entry.quantityChanged ? entry.remote.quantity : entry.remote.safetyQuantity),
        source: "cyberbiz_sync",
        actor,
      }));
    } finally {
      await releaseCyberbizSyncLock(db, entry.link.inventoryItemId, lockToken);
    }
  }
  return { updated, unchanged, failed };
}

export async function linkItemToCyberbiz(
  db: Database,
  input: { inventoryItemId: string; productId: string; variantId: string; sku: string; quantity: number; actor: { id: string; email: string } },
) {
  const [item] = await db.select({ item: itemMasters })
    .from(wmsItems)
    .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
    .where(eq(wmsItems.itemId, input.inventoryItemId))
    .limit(1);
  if (!item) throw new WmsError("not_found", "找不到這項商品。");
  if (normalizedSku(item.item.sku) !== normalizedSku(input.sku)) {
    throw new WmsError("conflict", "品項 SKU 與 CYBERBIZ 款式 SKU 不一致，不能建立連結。");
  }

  const [existingLink] = await db.select({
    productId: cyberbizProducts.cyberbizProductId,
    variantId: cyberbizProducts.cyberbizVariantId,
  })
    .from(cyberbizProducts)
    .where(eq(cyberbizProducts.itemId, input.inventoryItemId))
    .limit(1);
  if (existingLink) {
    if (existingLink.productId === input.productId && existingLink.variantId === input.variantId) {
      return { id: input.inventoryItemId };
    }
    throw new WmsError("conflict", "這項品項已經連結 CYBERBIZ 款式，不能改變既有身分。");
  }

  const [duplicate] = await db.select({ itemId: cyberbizProducts.itemId })
    .from(cyberbizProducts)
    .where(and(
      eq(cyberbizProducts.cyberbizProductId, input.productId),
      eq(cyberbizProducts.cyberbizVariantId, input.variantId),
      ne(cyberbizProducts.itemId, input.inventoryItemId),
    ))
    .limit(1);
  if (duplicate) throw new WmsError("conflict", "這個 CYBERBIZ 款式已經連到其他品項。");

  const now = new Date().toISOString();
  await db.batch([
    db.update(itemMasters).set({ source: "cyberbiz", updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(itemMasters.id, input.inventoryItemId)),
    db.insert(cyberbizProducts).values({
      itemId: input.inventoryItemId,
      cyberbizProductId: input.productId,
      cyberbizVariantId: input.variantId,
      productName: "",
      variantName: "",
      published: 1,
      rawJson: "{}",
      syncStatus: "synced",
      syncedAt: now,
    }).onConflictDoUpdate({
      target: cyberbizProducts.itemId,
      set: {
        cyberbizProductId: input.productId,
        cyberbizVariantId: input.variantId,
        syncStatus: "synced",
        syncedAt: now,
      },
    }),
    db.insert(activityEvents).values(activityRow({ entityType: "item", entityId: input.inventoryItemId, entityLabel: `${item.item.sku} ${item.item.name}`, eventType: "cyberbiz_linked", summary: `連結 CYBERBIZ 款式 ${input.variantId}`, source: "cyberbiz_sync", actor: input.actor })),
  ] as never);
  return { id: input.inventoryItemId };
}

export async function recordCyberbizSyncSucceeded(
  db: Database,
  context: { inventoryItemId: string; label: string; actor: { id?: string | null; email?: string | null } | null; quantity: number },
): Promise<void> {
  await db.insert(activityEvents).values(activityRow({
    entityType: "item",
    entityId: context.inventoryItemId,
    entityLabel: context.label,
    eventType: "cyberbiz_pushed",
    summary: "盤點數量已推上 CYBERBIZ",
    field: "quantity",
    newValue: String(context.quantity),
    source: "cyberbiz_sync",
    actor: context.actor,
  }));
}

export async function recordCyberbizSyncFailed(
  db: Database,
  context: { inventoryItemId: string; label: string; actor: { id?: string | null; email?: string | null } | null; error: string },
): Promise<void> {
  await db.insert(activityEvents).values(activityRow({
    entityType: "item",
    entityId: context.inventoryItemId,
    entityLabel: context.label,
    eventType: "cyberbiz_sync_failed",
    summary: "盤點已存，但沒有推上 CYBERBIZ",
    field: "quantity",
    source: "cyberbiz_sync",
    status: "failed",
    error: context.error,
    actor: context.actor,
  }));
}

/**
 * 盤點推送失敗不能只留在 activity log；下一個 cron 會用本地目前數量重新
 * 計算 absolute target。setCompanyQuantity 內部不再 retry 非冪等 delta，因此
 * 即使上一次 response 不明確，重試也會先重讀官網再 reconcile。
 */
export async function retryFailedCyberbizPushes(
  db: Database,
  client: CyberbizInventoryClient | undefined,
  options: { limit?: number } = {},
): Promise<{ attempted: number; recovered: number; failed: number }> {
  if (!client) return { attempted: 0, recovered: 0, failed: 0 };
  const limit = Math.max(1, Math.trunc(options.limit ?? 20));
  const rows = await db.select({
    itemId: activityEvents.entityId,
    eventType: activityEvents.eventType,
    createdAt: activityEvents.createdAt,
  })
    .from(activityEvents)
    .where(and(
      eq(activityEvents.entityType, "item"),
      eq(activityEvents.source, "cyberbiz_sync"),
      eq(activityEvents.field, "quantity"),
      inArray(activityEvents.eventType, ["cyberbiz_sync_failed", "cyberbiz_pushed"]),
    ))
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit * 4);

  const pendingIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.itemId)) continue;
    seen.add(row.itemId);
    if (row.eventType === "cyberbiz_sync_failed") pendingIds.push(row.itemId);
    if (pendingIds.length >= limit) break;
  }

  let recovered = 0;
  let failed = 0;
  for (const itemId of pendingIds) {
    const [link] = await listCompanyLinks(db, { inventoryItemId: itemId });
    if (!link) continue;
    const lockToken = await claimCyberbizSyncLock(db, itemId);
    if (!lockToken) continue;
    try {
      await client.setCompanyQuantity({
        productId: link.cyberbizProductId,
        variantId: link.cyberbizVariantId,
        sku: link.linkedSku,
        targetQuantity: link.quantity,
      });
      await setCyberbizProductSyncStatus(db, itemId, "synced");
      await recordCyberbizSyncSucceeded(db, {
        inventoryItemId: itemId,
        label: link.itemSku ? `${link.itemSku} ${link.itemName}` : link.itemName,
        actor: null,
        quantity: link.quantity,
      });
      recovered += 1;
    } catch (error) {
      await setCyberbizProductSyncStatus(db, itemId, "failed");
      failed += 1;
      await recordCyberbizSyncFailed(db, {
        inventoryItemId: itemId,
        label: link.itemSku ? `${link.itemSku} ${link.itemName}` : link.itemName,
        actor: null,
        error: error instanceof Error ? error.message : "CYBERBIZ 同步失敗",
      });
    } finally {
      await releaseCyberbizSyncLock(db, itemId, lockToken);
    }
  }
  return { attempted: pendingIds.length, recovered, failed };
}
