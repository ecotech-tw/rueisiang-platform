import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { inventoryItems, productCategories, productSkuMappings } from "./schema/wms.js";
import { WmsError, type Actor } from "./wms.js";

/** 外部 SKU 寫入前統一格式，避免大小寫造成兩筆 mapping。 */
export function normalizeExternalSku(value: string): string {
  return value.trim().toUpperCase();
}

/** 通路目前用文字保存；先統一大小寫，未來新增通路不用先改資料庫 enum。 */
export function normalizeProductSkuChannel(value: string): string {
  return value.trim().toLowerCase();
}

export interface ProductSkuMappingRow {
  id: string;
  inventoryItemId: string;
  channel: string;
  externalSku: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSkuMappingManagementRow extends ProductSkuMappingRow {
  itemSku: string | null;
  itemName: string;
  itemCategory: string;
  itemCategoryColor: string | null;
}

export interface ProductSkuMappingItemOption {
  id: string;
  sku: string | null;
  name: string;
  category: string;
}

export interface ProductSkuMappingManagementData {
  mappings: ProductSkuMappingManagementRow[];
  items: ProductSkuMappingItemOption[];
}

export interface ResolvedProductSku {
  inventoryItemId: string;
  sku: string;
  name: string;
  category: string;
}

const SKU_LOOKUP_BATCH_SIZE = 50;

export async function listProductSkuMappings(
  db: Database,
  inventoryItemId?: string,
): Promise<ProductSkuMappingRow[]> {
  return db
    .select()
    .from(productSkuMappings)
    .where(inventoryItemId ? eq(productSkuMappings.inventoryItemId, inventoryItemId) : undefined)
    .orderBy(asc(productSkuMappings.channel), asc(productSkuMappings.externalSku));
}

/**
 * SKU 對應管理頁需要的兩份資料。
 *
 * 商品名稱、正式 SKU 與分類都從 inventory_items 讀取，避免管理頁顯示一份過期的複本；
 * items 只供新增 mapping 時選擇，不包含倉位、數量或其他不相關的倉儲資料。
 */
export async function loadProductSkuMappingManagement(
  db: Database,
): Promise<ProductSkuMappingManagementData> {
  const [mappingRows, itemRows] = await Promise.all([
    db
      .select({
        id: productSkuMappings.id,
        inventoryItemId: productSkuMappings.inventoryItemId,
        channel: productSkuMappings.channel,
        externalSku: productSkuMappings.externalSku,
        createdAt: productSkuMappings.createdAt,
        updatedAt: productSkuMappings.updatedAt,
        itemSku: inventoryItems.sku,
        itemName: inventoryItems.name,
        itemCategory: inventoryItems.category,
        itemCategoryColor: productCategories.color,
      })
      .from(productSkuMappings)
      .innerJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
      .leftJoin(productCategories, eq(productCategories.name, inventoryItems.category))
      .orderBy(asc(productSkuMappings.channel), asc(productSkuMappings.externalSku)),
    db
      .select({
        id: inventoryItems.id,
        sku: inventoryItems.sku,
        name: inventoryItems.name,
        category: inventoryItems.category,
      })
      .from(inventoryItems)
      .orderBy(asc(inventoryItems.name)),
  ]);

  return { mappings: mappingRows, items: itemRows };
}

export async function addProductSkuMapping(
  db: Database,
  input: { inventoryItemId: string; channel?: string; externalSku: string; actor: Actor },
): Promise<{ id: string; channel: string; externalSku: string }> {
  const channel = normalizeProductSkuChannel(input.channel ?? "legacy");
  if (!channel) throw new WmsError("invalid", "通路不可為空。 ");
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。 ");

  const [item] = await db
    .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, input.inventoryItemId));
  if (!item) throw new WmsError("not_found", "找不到這項商品。 ");
  if (!item.sku) throw new WmsError("invalid", "請先設定 WMS SKU，才能建立外部 SKU 對應。 ");

  const [skuOwner] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`UPPER(${inventoryItems.sku}) = ${externalSku}`)
    .limit(1);
  if (skuOwner && skuOwner.id !== input.inventoryItemId) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」與其他商品的 WMS SKU 衝突。 `);
  }

  const [existing] = await db
    .select({ id: productSkuMappings.id, inventoryItemId: productSkuMappings.inventoryItemId })
    .from(productSkuMappings)
    .where(and(
      eq(productSkuMappings.channel, channel),
      eq(productSkuMappings.externalSku, externalSku),
    ))
    .limit(1);
  if (existing) {
    if (existing.inventoryItemId === input.inventoryItemId) {
      return { id: existing.id, channel, externalSku };
    }
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經對應到其他商品。 `);
  }

  const id = crypto.randomUUID();
  await db.batch([
    db.insert(productSkuMappings).values({ id, inventoryItemId: input.inventoryItemId, channel, externalSku }),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${item.sku} ${item.name}`,
      eventType: "product_sku_mapping_created",
      summary: `新增${channel} 外部 SKU 對應：${externalSku}`,
      field: "externalSku",
      newValue: externalSku,
      actor: input.actor,
      source: "wms",
    })),
  ]);

  return { id, channel, externalSku };
}

export async function deleteProductSkuMapping(
  db: Database,
  id: string,
  actor: Actor,
): Promise<void> {
  const [mapping] = await db
    .select({
      id: productSkuMappings.id,
      channel: productSkuMappings.channel,
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
      summary: `移除${mapping.channel} 外部 SKU 對應：${mapping.externalSku}`,
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
  channel = "legacy",
): Promise<Map<string, ResolvedProductSku>> {
  const wanted = [...new Set(externalSkus.map(normalizeExternalSku).filter(Boolean))];
  if (!wanted.length) return new Map();
  const normalizedChannel = normalizeProductSkuChannel(channel) || "legacy";
  const lookupChannels = [...new Set([normalizedChannel, "legacy"])] as string[];

  type MappingLookup = {
    externalSku: string;
    channel: string;
    inventoryItemId: string;
    sku: string | null;
    name: string;
    category: string;
  };
  type DirectItemLookup = {
    id: string;
    sku: string | null;
    name: string;
    category: string;
  };
  const mappings: MappingLookup[] = [];
  const directItems: DirectItemLookup[] = [];

  // D1 單支 SQL 的 bound parameter 有上限；報表可能有數百個 SKU，不能一次塞完整份 IN。
  for (let offset = 0; offset < wanted.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = wanted.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    const [batchMappings, batchDirectItems] = await Promise.all([
      db
        .select({
          externalSku: productSkuMappings.externalSku,
          channel: productSkuMappings.channel,
          inventoryItemId: productSkuMappings.inventoryItemId,
          sku: inventoryItems.sku,
          name: inventoryItems.name,
          category: inventoryItems.category,
        })
        .from(productSkuMappings)
        .innerJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
        .where(and(
          inArray(productSkuMappings.externalSku, batch),
          inArray(productSkuMappings.channel, lookupChannels),
        )),
      db
        .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name, category: inventoryItems.category })
        .from(inventoryItems)
        .where(sql`UPPER(${inventoryItems.sku}) IN (${sql.join(batch.map((sku) => sql`${sku}`), sql`, `)})`),
    ]);
    mappings.push(...batchMappings);
    directItems.push(...batchDirectItems);
  }

  const resolved = new Map<string, ResolvedProductSku>();
  const resolvedChannels = new Map<string, string>();
  const mappedKeys = new Set(mappings.map((mapping) => normalizeExternalSku(mapping.externalSku)));
  for (const item of directItems) {
    const key = item.sku ? normalizeExternalSku(item.sku) : "";
    // 明確 mapping 優先於「外部 SKU 剛好等於 WMS SKU」的 implicit match。
    if (item.sku && !mappedKeys.has(key)) resolved.set(key, {
      inventoryItemId: item.id,
      sku: item.sku,
      name: item.name,
      category: item.category,
    });
  }
  for (const mapping of mappings) {
    if (!mapping.sku) continue;
    const key = normalizeExternalSku(mapping.externalSku);
    const previous = resolved.get(key);
    if (previous && resolvedChannels.get(key) === normalizedChannel && mapping.channel !== normalizedChannel) continue;
    resolved.set(key, {
      inventoryItemId: mapping.inventoryItemId,
      sku: mapping.sku,
      name: mapping.name,
      category: mapping.category,
    });
    resolvedChannels.set(key, mapping.channel);
  }
  return resolved;
}
