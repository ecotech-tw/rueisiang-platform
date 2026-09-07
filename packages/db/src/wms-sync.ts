import { and, eq, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { cyberbizProducts, items as itemMasters } from "./schema/items.js";
import { activityEvents } from "./schema/activity.js";
import { wmsItems } from "./schema/wms.js";
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
  }));
}

export interface SyncOutcome { updated: number; unchanged: number; failed: number }

function updateLinkedItem(db: Database, itemId: string, values: Record<string, unknown>) {
  return db.update(wmsItems).set(values as never).where(eq(wmsItems.itemId, itemId));
}

export async function applySyncPlan(
  db: Database,
  plan: SyncPlanEntry[],
  actor: { id?: string | null; email?: string | null } | null,
): Promise<SyncOutcome> {
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
        db.insert(activityEvents).values(activityRow({ entityType: "item", entityId: entry.link.inventoryItemId, entityLabel: label, eventType: "cyberbiz_sync_failed", summary: entry.error, source: "cyberbiz_sync", status: "failed", error: entry.error, actor })),
      );
      continue;
    }
    if (!entry.quantityChanged && !entry.minStockChanged) {
      unchanged += 1;
      continue;
    }
    updated += 1;
    statements.push(
      updateLinkedItem(db, entry.link.inventoryItemId, { quantity: entry.remote.quantity, minStock: entry.remote.safetyQuantity, updatedAt: sql`CURRENT_TIMESTAMP` }),
      db.insert(activityEvents).values(activityRow({ entityType: "item", entityId: entry.link.inventoryItemId, entityLabel: label, eventType: "cyberbiz_synced", summary: entry.quantityChanged ? "從 CYBERBIZ 同步庫存數量" : "從 CYBERBIZ 同步安全庫存", field: entry.quantityChanged ? "quantity" : "minStock", oldValue: String(entry.quantityChanged ? entry.link.quantity : entry.link.minStock), newValue: String(entry.quantityChanged ? entry.remote.quantity : entry.remote.safetyQuantity), source: "cyberbiz_sync", actor })),
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
  const [item] = await db.select({ item: itemMasters })
    .from(wmsItems)
    .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
    .where(eq(wmsItems.itemId, input.inventoryItemId))
    .limit(1);
  if (!item) throw new WmsError("not_found", "找不到這項商品。");
  if (normalizedSku(item.item.sku) !== normalizedSku(input.sku)) {
    throw new WmsError("conflict", "品項 SKU 與 CYBERBIZ 款式 SKU 不一致，不能建立連結。");
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

export async function recordCyberbizSyncFailed(
  db: Database,
  context: { inventoryItemId: string; label: string; actor: { id: string; email: string }; error: string },
): Promise<void> {
  await db.insert(activityEvents).values(activityRow({
    entityType: "item",
    entityId: context.inventoryItemId,
    entityLabel: context.label,
    eventType: "cyberbiz_sync_failed",
    summary: "盤點已存，但沒有推上 CYBERBIZ",
    source: "cyberbiz_sync",
    status: "failed",
    error: context.error,
    actor: context.actor,
  }));
}
