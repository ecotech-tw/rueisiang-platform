import { eq, inArray, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { inventoryItems, productSkuMappings } from "./schema/wms.js";
import { WmsError, type Actor } from "./wms.js";

/** 外部 SKU 是跨通路的查詢鍵，寫入前統一格式，避免大小寫造成兩筆 mapping。 */
export function normalizeExternalSku(value: string): string {
  return value.trim().toUpperCase();
}

export interface ProductSkuMappingRow {
  id: string;
  inventoryItemId: string;
  externalSku: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedProductSku {
  inventoryItemId: string;
  sku: string;
  name: string;
  category: string;
}

export async function listProductSkuMappings(
  db: Database,
  inventoryItemId?: string,
): Promise<ProductSkuMappingRow[]> {
  return db
    .select()
    .from(productSkuMappings)
    .where(inventoryItemId ? eq(productSkuMappings.inventoryItemId, inventoryItemId) : undefined)
    .orderBy(productSkuMappings.externalSku);
}

export async function addProductSkuMapping(
  db: Database,
  input: { inventoryItemId: string; externalSku: string; actor: Actor },
): Promise<{ id: string; externalSku: string }> {
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。 ");

  const [item] = await db
    .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, input.inventoryItemId));
  if (!item) throw new WmsError("not_found", "找不到這項商品。 ");
  if (!item.sku) throw new WmsError("invalid", "請先設定 WMS SKU，才能建立外部 SKU 對應。 ");

  const [existing] = await db
    .select({ id: productSkuMappings.id, inventoryItemId: productSkuMappings.inventoryItemId })
    .from(productSkuMappings)
    .where(eq(productSkuMappings.externalSku, externalSku))
    .limit(1);
  if (existing) {
    if (existing.inventoryItemId === input.inventoryItemId) {
      return { id: existing.id, externalSku };
    }
    throw new WmsError("conflict", `外部 SKU「${externalSku}」已經對應到其他商品。 `);
  }

  const id = crypto.randomUUID();
  await db.batch([
    db.insert(productSkuMappings).values({ id, inventoryItemId: input.inventoryItemId, externalSku }),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${item.sku} ${item.name}`,
      eventType: "product_sku_mapping_created",
      summary: `新增外部 SKU 對應：${externalSku}`,
      field: "externalSku",
      newValue: externalSku,
      actor: input.actor,
      source: "wms",
    })),
  ]);

  return { id, externalSku };
}

export async function deleteProductSkuMapping(
  db: Database,
  id: string,
  actor: Actor,
): Promise<void> {
  const [mapping] = await db
    .select({
      id: productSkuMappings.id,
      externalSku: productSkuMappings.externalSku,
      itemSku: inventoryItems.sku,
      itemName: inventoryItems.name,
    })
    .from(productSkuMappings)
    .innerJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
    .where(eq(productSkuMappings.id, id));
  if (!mapping) throw new WmsError("not_found", "找不到這筆外部 SKU 對應。 ");

  await db.batch([
    db.delete(productSkuMappings).where(eq(productSkuMappings.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${mapping.itemSku ?? ""} ${mapping.itemName}`.trim(),
      eventType: "product_sku_mapping_deleted",
      summary: `移除外部 SKU 對應：${mapping.externalSku}`,
      field: "externalSku",
      oldValue: mapping.externalSku,
      actor,
      source: "wms",
    })),
  ]);
}

/**
 * 一次解析整份報表的外部 SKU，避免匯入時逐列查詢 D1。
 *
 * 若外部 SKU 剛好就是正式 WMS SKU，也允許直接命中 inventory_items，讓既有
 * CYBERBIZ 報表不必先人工建立一筆內容完全相同的 mapping。
 */
export async function resolveProductSkus(
  db: Database,
  externalSkus: readonly string[],
): Promise<Map<string, ResolvedProductSku>> {
  const wanted = [...new Set(externalSkus.map(normalizeExternalSku).filter(Boolean))];
  if (!wanted.length) return new Map();

  const [mappings, directItems] = await Promise.all([
    db
      .select({
        externalSku: productSkuMappings.externalSku,
        inventoryItemId: productSkuMappings.inventoryItemId,
        sku: inventoryItems.sku,
        name: inventoryItems.name,
        category: inventoryItems.category,
      })
      .from(productSkuMappings)
      .innerJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
      .where(inArray(productSkuMappings.externalSku, wanted)),
    db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name, category: inventoryItems.category })
      .from(inventoryItems)
      .where(sql`UPPER(${inventoryItems.sku}) IN (${sql.join(wanted.map((sku) => sql`${sku}`), sql`, `)})`),
  ]);

  const resolved = new Map<string, ResolvedProductSku>();
  for (const item of directItems) {
    if (item.sku) resolved.set(normalizeExternalSku(item.sku), {
      inventoryItemId: item.id,
      sku: item.sku,
      name: item.name,
      category: item.category,
    });
  }
  for (const mapping of mappings) {
    if (!mapping.sku) continue;
    const key = normalizeExternalSku(mapping.externalSku);
    const direct = resolved.get(key);
    if (direct && direct.inventoryItemId !== mapping.inventoryItemId) {
      throw new WmsError("conflict", `外部 SKU「${mapping.externalSku}」同時對應到不同商品。 `);
    }
    resolved.set(key, {
      inventoryItemId: mapping.inventoryItemId,
      sku: mapping.sku,
      name: mapping.name,
      category: mapping.category,
    });
  }
  return resolved;
}
