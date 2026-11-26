import type { CyberbizInventoryClient, CyberbizInventoryItem } from "@rueisiang/cyberbiz";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { normalizeDbTimestamp, toDbTimestamp } from "./db-timestamp.js";
import { cyberbizProducts, items as itemMasters } from "./schema/items.js";
import { activityEvents } from "./schema/activity.js";
import { cyberbizSyncLocks, wmsItems } from "./schema/wms.js";
import { WmsError } from "./wms.js";
import { hasUnresolvedOrderRestock } from "./order-restock-state.js";

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
  expectedLink?: Pick<LinkedItem, "cyberbizProductId" | "cyberbizVariantId">,
): Promise<void> {
  await db.update(cyberbizProducts).set({
    syncStatus: status,
    ...(status === "synced" ? { syncedAt: sql`CURRENT_TIMESTAMP` } : {}),
  }).where(and(
    eq(cyberbizProducts.itemId, itemId),
    ...(expectedLink ? [
      eq(cyberbizProducts.cyberbizProductId, expectedLink.cyberbizProductId),
      eq(cyberbizProducts.cyberbizVariantId, expectedLink.cyberbizVariantId),
    ] : []),
  ));
}

function updateLinkedItem(
  db: Database,
  link: LinkedItem,
  values: Record<string, unknown>,
) {
  const snapshot = and(
    eq(wmsItems.quantity, link.quantity),
    eq(wmsItems.minStock, link.minStock),
    sql`EXISTS (
      SELECT 1 FROM cyberbiz_products
      WHERE cyberbiz_products.item_id = ${wmsItems.itemId}
        AND cyberbiz_products.cyberbiz_product_id = ${link.cyberbizProductId}
        AND cyberbiz_products.cyberbiz_variant_id = ${link.cyberbizVariantId}
    )`,
    ...(link.updatedAt ? [eq(wmsItems.updatedAt, link.updatedAt)] : []),
    sql`NOT EXISTS (
      SELECT 1 FROM cyberbiz_order_restocks r
      WHERE r.item_id = ${wmsItems.itemId} AND r.mode = 'apply'
        AND r.state IN ('pending', 'checking', 'applying', 'review')
    )`,
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
    const [currentLink] = await db.select({ itemId: cyberbizProducts.itemId })
      .from(cyberbizProducts)
      .where(and(
        eq(cyberbizProducts.itemId, entry.link.inventoryItemId),
        eq(cyberbizProducts.cyberbizProductId, entry.link.cyberbizProductId),
        eq(cyberbizProducts.cyberbizVariantId, entry.link.cyberbizVariantId),
      ))
      .limit(1);
    if (!currentLink) {
      unchanged += 1;
      continue;
    }
    if (await hasUnresolvedOrderRestock(db, entry.link.inventoryItemId)) {
      failed += 1;
      await db.insert(activityEvents).values(activityRow({
        entityType: "item", entityId: entry.link.inventoryItemId, entityLabel: label,
        eventType: "cyberbiz_sync_deferred", source: "cyberbiz_sync", status: "failed",
        summary: "此品項有待處理或待確認的訂單回補，暫不以官網快照覆蓋 WMS。",
      }));
      continue;
    }
    if (entry.status === "failed" || !entry.remote) {
      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "failed", entry.link);
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
      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "synced", entry.link);
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
      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "failed", entry.link);
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
        await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "failed", entry.link);
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

      await setCyberbizProductSyncStatus(db, entry.link.inventoryItemId, "synced", entry.link);
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

interface CyberbizLinkRepairCandidate {
  itemId: string;
  sku: string;
  name: string;
  quantity: number;
  minStock: number;
  productId: string;
  variantId: string;
  remote: CyberbizInventoryItem;
}

async function resolveCyberbizLinkRepair(
  db: Database,
  input: {
    inventoryItemId: string;
    expectedProductId: string;
    expectedVariantId: string;
    products: ReadonlyArray<CyberbizInventoryItem>;
  },
): Promise<CyberbizLinkRepairCandidate> {
  const [current] = await db.select({
    itemId: itemMasters.id,
    sku: itemMasters.sku,
    name: itemMasters.name,
    quantity: wmsItems.quantity,
    minStock: wmsItems.minStock,
    productId: cyberbizProducts.cyberbizProductId,
    variantId: cyberbizProducts.cyberbizVariantId,
  })
    .from(wmsItems)
    .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
    .innerJoin(cyberbizProducts, eq(cyberbizProducts.itemId, wmsItems.itemId))
    .where(eq(wmsItems.itemId, input.inventoryItemId))
    .limit(1);
  if (!current) throw new WmsError("not_found", "找不到已連結 CYBERBIZ 的倉儲品項。");
  if (current.productId !== input.expectedProductId || current.variantId !== input.expectedVariantId) {
    throw new WmsError("conflict", "CYBERBIZ 連結已被其他操作更新，請重新檢查。");
  }
  const matches = input.products.filter((product) =>
    product.posShopId === "" && normalizedSku(product.sku) === normalizedSku(current.sku),
  );
  if (!matches.length) throw new WmsError("not_found", `官網目前找不到公司倉 SKU「${current.sku}」，連結未變更。`);
  if (matches.length > 1) {
    throw new WmsError("conflict", `官網有 ${matches.length} 個款式使用 SKU「${current.sku}」，為避免連錯，連結未變更。`);
  }
  const remote = matches[0]!;
  if (current.productId !== remote.productId || current.variantId !== remote.variantId) {
    const [owner] = await db.select({ itemId: cyberbizProducts.itemId })
      .from(cyberbizProducts)
      .where(and(
        eq(cyberbizProducts.cyberbizProductId, remote.productId),
        eq(cyberbizProducts.cyberbizVariantId, remote.variantId),
        ne(cyberbizProducts.itemId, current.itemId),
      ))
      .limit(1);
    if (owner) throw new WmsError("conflict", "這個 CYBERBIZ 款式已連結其他品項，不能移轉連結。");
  }
  return { ...current, remote };
}

export async function previewCyberbizItemLinkRepair(
  db: Database,
  input: Parameters<typeof resolveCyberbizLinkRepair>[1],
) {
  const candidate = await resolveCyberbizLinkRepair(db, input);
  return {
    changed: candidate.productId !== candidate.remote.productId || candidate.variantId !== candidate.remote.variantId,
    oldProductId: candidate.productId,
    oldVariantId: candidate.variantId,
    newProductId: candidate.remote.productId,
    newVariantId: candidate.remote.variantId,
    sku: candidate.sku,
    wmsQuantity: candidate.quantity,
    wmsSafetyQuantity: candidate.minStock,
    remote: candidate.remote,
  };
}

export async function repairCyberbizItemLink(
  db: Database,
  input: Parameters<typeof resolveCyberbizLinkRepair>[1] & {
    expectedNewProductId: string;
    expectedNewVariantId: string;
    actor: { id: string; email: string };
  },
) {
  const lockToken = await claimCyberbizSyncLock(db, input.inventoryItemId);
  if (!lockToken) throw new WmsError("conflict", "商品正在同步中，請稍後重新檢查連結。");

  try {
    const candidate = await resolveCyberbizLinkRepair(db, input);
    const { remote } = candidate;
    if (input.expectedNewProductId !== remote.productId || input.expectedNewVariantId !== remote.variantId) {
      throw new WmsError("conflict", "官網款式已在檢查後變更，請重新檢查再確認。");
    }
    if (candidate.productId === remote.productId && candidate.variantId === remote.variantId) {
      return {
        changed: false,
        oldProductId: candidate.productId,
        oldVariantId: candidate.variantId,
        newProductId: remote.productId,
        newVariantId: remote.variantId,
        sku: candidate.sku,
        wmsQuantity: candidate.quantity,
        wmsSafetyQuantity: candidate.minStock,
        remote,
      };
    }

    const activity = activityRow({
      entityType: "item",
      entityId: candidate.itemId,
      entityLabel: `${candidate.sku} ${candidate.name}`,
      eventType: "cyberbiz_relinked",
      summary: "修復 CYBERBIZ 款式連結",
      field: "cyberbiz_variant_id",
      oldValue: `${candidate.productId}/${candidate.variantId}`,
      newValue: `${remote.productId}/${remote.variantId}`,
      payload: {
        sku: candidate.sku,
        productName: remote.productName,
        variantName: remote.variantName,
        quantity: remote.quantity,
        safetyQuantity: remote.safetyQuantity,
      },
      source: "cyberbiz_sync",
      actor: input.actor,
    });
    await db.batch([
      db.update(cyberbizProducts).set({
        cyberbizProductId: remote.productId,
        cyberbizVariantId: remote.variantId,
        productName: remote.productName,
        variantName: remote.variantName,
        published: remote.published ? 1 : 0,
        cyberbizUpdatedAt: normalizeDbTimestamp(remote.updatedAt),
        syncStatus: "synced",
        syncedAt: toDbTimestamp(),
      }).where(and(
        eq(cyberbizProducts.itemId, candidate.itemId),
        eq(cyberbizProducts.cyberbizProductId, input.expectedProductId),
        eq(cyberbizProducts.cyberbizVariantId, input.expectedVariantId),
      )),
      db.insert(activityEvents).values(activity),
    ] as never);

    return {
      changed: true,
      oldProductId: candidate.productId,
      oldVariantId: candidate.variantId,
      newProductId: remote.productId,
      newVariantId: remote.variantId,
      sku: candidate.sku,
      wmsQuantity: candidate.quantity,
      wmsSafetyQuantity: candidate.minStock,
      remote,
    };
  } finally {
    await releaseCyberbizSyncLock(db, input.inventoryItemId, lockToken);
  }
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

  const now = toDbTimestamp();
  try {
    // 不使用 onConflictDoUpdate：兩個並行 link request 不能把既有外部身分改掉。
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
      }),
      db.insert(activityEvents).values(activityRow({ entityType: "item", entityId: input.inventoryItemId, entityLabel: `${item.item.sku} ${item.item.name}`, eventType: "cyberbiz_linked", summary: `連結 CYBERBIZ 款式 ${input.variantId}`, source: "cyberbiz_sync", actor: input.actor })),
    ] as never);
  } catch (error) {
    // 競爭 request 可能已經先完成；相同 mapping 仍保持冪等，不同 mapping 一律拒絕。
    const [raced] = await db.select({
      productId: cyberbizProducts.cyberbizProductId,
      variantId: cyberbizProducts.cyberbizVariantId,
    }).from(cyberbizProducts).where(eq(cyberbizProducts.itemId, input.inventoryItemId)).limit(1);
    if (raced) {
      if (raced.productId === input.productId && raced.variantId === input.variantId) {
        return { id: input.inventoryItemId };
      }
      throw new WmsError("conflict", "這項品項已經連結 CYBERBIZ 款式，不能改變既有身分。");
    }
    const [racedDuplicate] = await db.select({ itemId: cyberbizProducts.itemId })
      .from(cyberbizProducts)
      .where(and(
        eq(cyberbizProducts.cyberbizProductId, input.productId),
        eq(cyberbizProducts.cyberbizVariantId, input.variantId),
      ))
      .limit(1);
    if (racedDuplicate) throw new WmsError("conflict", "這個 CYBERBIZ 款式已經連到其他品項。");
    throw error;
  }
  return { id: input.inventoryItemId };
}

export async function recordCyberbizSyncSucceeded(
  db: Database,
  context: { inventoryItemId: string; label: string; actor: { id?: string | null; email?: string | null } | null; quantity: number },
): Promise<void> {
  await setCyberbizProductSyncStatus(db, context.inventoryItemId, "synced");
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
  await setCyberbizProductSyncStatus(db, context.inventoryItemId, "failed");
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
    // created_at 既有資料只有秒精度；rowid 才能判斷同秒內哪筆是後寫的。
    .orderBy(
      desc(sql`julianday(${activityEvents.createdAt})`),
      desc(sql`rowid`),
    )
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
    // 這次查詢只用來確認 item 仍然存在；真正要推送的數量必須在取得 lease
    // 後重讀，避免等待另一個盤點完成期間拿舊 snapshot 覆蓋新數量。
    const [candidate] = await listCompanyLinks(db, { inventoryItemId: itemId });
    if (!candidate) continue;
    const lockToken = await claimCyberbizSyncLock(db, itemId);
    if (!lockToken) continue;
    try {
      const [link] = await listCompanyLinks(db, { inventoryItemId: itemId });
      if (!link || await hasUnresolvedOrderRestock(db, itemId)) continue;
      await client.setCompanyQuantity({
        productId: link.cyberbizProductId,
        variantId: link.cyberbizVariantId,
        sku: link.linkedSku,
        targetQuantity: link.quantity,
        beforeAdjust: async () => {
          const [current] = await listCompanyLinks(db, { inventoryItemId: itemId });
          if (await hasUnresolvedOrderRestock(db, itemId)) throw new Error("讀取官網期間有新訂單回補入帳，未送出盤點補推。");
          if (!current || current.quantity !== link.quantity || current.updatedAt !== link.updatedAt || current.cyberbizProductId !== link.cyberbizProductId || current.cyberbizVariantId !== link.cyberbizVariantId) {
            throw new Error("送出前 WMS 數量或連結已變更，未送出舊盤點補推。");
          }
        },
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
        label: candidate.itemSku ? `${candidate.itemSku} ${candidate.itemName}` : candidate.itemName,
        actor: null,
        error: error instanceof Error ? error.message : "CYBERBIZ 同步失敗",
      });
    } finally {
      await releaseCyberbizSyncLock(db, itemId, lockToken);
    }
  }
  return { attempted: pendingIds.length, recovered, failed };
}
