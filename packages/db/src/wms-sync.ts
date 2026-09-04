import { eq, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { items as itemMasters } from "./schema/items.js";
import { wmsCyberbizLinks, wmsItems } from "./schema/wms.js";
import { WmsError } from "./wms.js";

export interface LinkedItem {
  linkId: string;
  /** target wms_items.item_id；保留既有 API 欄位名稱。 */
  inventoryItemId: string;
  cyberbizProductId: string;
  cyberbizVariantId: string;
  linkedSku: string;
  itemSku: string;
  itemName: string;
  quantity: number;
  minStock: number;
}

export interface RemoteItem { productId: string; variantId: string; sku: string; quantity: number; safetyQuantity: number }
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
  const byVariant = new Map(remotes.map((item) => [item.variantId, item]));
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

export async function listCompanyLinks(db: Database, productId?: string): Promise<LinkedItem[]> {
  return db.select({
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
    .where(productId
      ? sql`${wmsCyberbizLinks.warehouseScope} = 'company' AND ${wmsCyberbizLinks.cyberbizProductId} = ${productId}`
      : sql`${wmsCyberbizLinks.warehouseScope} = 'company'`);
}

export interface SyncOutcome { updated: number; unchanged: number; failed: number }

function updateLink(db: Database, linkId: string, values: Record<string, unknown>) {
  return db.update(wmsCyberbizLinks).set(values as never).where(eq(wmsCyberbizLinks.id, linkId));
}
function updateLinkedItem(db: Database, itemId: string, values: Record<string, unknown>) {
  return db.update(wmsItems).set(values as never).where(eq(wmsItems.itemId, itemId));
}

export async function applySyncPlan(
  db: Database,
  plan: SyncPlanEntry[],
  actor: { id?: string | null; email?: string | null } | null,
): Promise<SyncOutcome> {
  const syncedAt = new Date().toISOString();
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
        updateLink(db, entry.link.linkId, { syncStatus: "failed", lastError: entry.error, updatedAt: sql`CURRENT_TIMESTAMP` }),
        db.insert(activityEvents).values(activityRow({ entityType: "inventory_item", entityId: entry.link.inventoryItemId, entityLabel: label, eventType: "cyberbiz_sync_failed", summary: entry.error, source: "cyberbiz_sync", status: "failed", error: entry.error, actor })),
      );
      continue;
    }
    if (!entry.quantityChanged && !entry.minStockChanged) {
      unchanged += 1;
      statements.push(updateLink(db, entry.link.linkId, { syncStatus: "synced", lastError: "", lastSyncedQuantity: entry.remote.quantity, lastSyncedAt: syncedAt, updatedAt: sql`CURRENT_TIMESTAMP` }));
      continue;
    }
    updated += 1;
    statements.push(
      updateLinkedItem(db, entry.link.inventoryItemId, { quantity: entry.remote.quantity, minStock: entry.remote.safetyQuantity, updatedAt: sql`CURRENT_TIMESTAMP` }),
      updateLink(db, entry.link.linkId, { syncStatus: "synced", lastError: "", lastSyncedQuantity: entry.remote.quantity, lastSyncedAt: syncedAt, updatedAt: sql`CURRENT_TIMESTAMP` }),
      db.insert(activityEvents).values(activityRow({ entityType: "inventory_item", entityId: entry.link.inventoryItemId, entityLabel: label, eventType: "cyberbiz_synced", summary: entry.quantityChanged ? "從 CYBERBIZ 同步庫存數量" : "從 CYBERBIZ 同步安全庫存", field: entry.quantityChanged ? "quantity" : "minStock", oldValue: String(entry.quantityChanged ? entry.link.quantity : entry.link.minStock), newValue: String(entry.quantityChanged ? entry.remote.quantity : entry.remote.safetyQuantity), source: "cyberbiz_sync", actor })),
    );
  }
  for (let index = 0; index < statements.length; index += 50) {
    const slice = statements.slice(index, index + 50);
    if (slice.length) await db.batch(slice as [Statement, ...Statement[]]);
  }
  return { updated, unchanged, failed };
}

export async function linkItemToCyberbiz(
  db: Database,
  input: { inventoryItemId: string; productId: string; variantId: string; sku: string; quantity: number; actor: { id: string; email: string } },
) {
  const [item] = await db.select({ sku: itemMasters.sku, name: itemMasters.name }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, input.inventoryItemId)).limit(1);
  if (!item) throw new WmsError("not_found", "找不到這項商品。");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    db.insert(wmsCyberbizLinks).values({ id, wmsItemId: input.inventoryItemId, cyberbizProductId: input.productId, cyberbizVariantId: input.variantId, sku: input.sku.trim().toUpperCase(), warehouseScope: "company", syncStatus: "synced", lastSyncedQuantity: input.quantity, lastSyncedAt: now }),
    db.insert(activityEvents).values(activityRow({ entityType: "inventory_item", entityId: input.inventoryItemId, entityLabel: `${item.sku} ${item.name}`, eventType: "cyberbiz_linked", summary: `連結 CYBERBIZ 款式 ${input.variantId}`, source: "cyberbiz_sync", actor: input.actor })),
  ] as never);
  return { id };
}

export async function unlinkItemFromCyberbiz(db: Database, inventoryItemId: string, actor: { id: string; email: string }) {
  const [item] = await db.select({ sku: itemMasters.sku, name: itemMasters.name }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, inventoryItemId)).limit(1);
  if (!item) throw new WmsError("not_found", "找不到這項商品。");
  await db.batch([
    db.delete(wmsCyberbizLinks).where(eq(wmsCyberbizLinks.wmsItemId, inventoryItemId)),
    db.insert(activityEvents).values(activityRow({ entityType: "inventory_item", entityId: inventoryItemId, entityLabel: `${item.sku} ${item.name}`, eventType: "cyberbiz_unlinked", summary: "解除 CYBERBIZ 連結（庫存數量保留）", source: "cyberbiz_sync", actor })),
  ] as never);
}

export async function markLinkSynced(db: Database, linkId: string, quantity: number): Promise<void> {
  await updateLink(db, linkId, { syncStatus: "synced", lastError: "", lastSyncedQuantity: quantity, lastSyncedAt: new Date().toISOString(), updatedAt: sql`CURRENT_TIMESTAMP` });
}

export async function markLinkFailed(
  db: Database,
  linkId: string,
  error: string,
  context: { inventoryItemId: string; label: string; actor: { id: string; email: string } },
): Promise<void> {
  await db.batch([
    updateLink(db, linkId, { syncStatus: "failed", lastError: error, updatedAt: sql`CURRENT_TIMESTAMP` }),
    db.insert(activityEvents).values(activityRow({ entityType: "inventory_item", entityId: context.inventoryItemId, entityLabel: context.label, eventType: "cyberbiz_sync_failed", summary: "盤點已存，但沒有推上 CYBERBIZ", source: "cyberbiz_sync", status: "failed", error, actor: context.actor })),
  ] as never);
}
