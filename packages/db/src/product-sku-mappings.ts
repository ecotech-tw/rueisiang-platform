import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import {
  inventoryItems,
  productBundleComponents,
  productCategories,
  productSkuMappings,
} from "./schema/wms.js";
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
  components: ProductBundleComponentManagementRow[];
}

export interface ProductBundleComponentManagementRow {
  inventoryItemId: string;
  quantity: number;
  sku: string | null;
  name: string;
  category: string;
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
  components: ResolvedProductSkuComponent[];
}

export interface ResolvedProductSkuComponent {
  inventoryItemId: string;
  sku: string;
  name: string;
  category: string;
  quantity: number;
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

  const componentRows: Array<{
    mappingId: string;
    inventoryItemId: string;
    quantity: number;
    sku: string | null;
    name: string;
    category: string;
  }> = [];
  const mappingIds = mappingRows.map((row) => row.id);
  for (let offset = 0; offset < mappingIds.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = mappingIds.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    componentRows.push(...await db
      .select({
        mappingId: productBundleComponents.mappingId,
        inventoryItemId: productBundleComponents.inventoryItemId,
        quantity: productBundleComponents.quantity,
        sku: inventoryItems.sku,
        name: inventoryItems.name,
        category: inventoryItems.category,
      })
      .from(productBundleComponents)
      .innerJoin(inventoryItems, eq(inventoryItems.id, productBundleComponents.inventoryItemId))
      .where(inArray(productBundleComponents.mappingId, batch))
      .orderBy(asc(productBundleComponents.mappingId), asc(inventoryItems.name)));
  }
  const componentsByMapping = new Map<string, ProductBundleComponentManagementRow[]>();
  for (const component of componentRows) {
    const list = componentsByMapping.get(component.mappingId) ?? [];
    list.push({
      inventoryItemId: component.inventoryItemId,
      quantity: component.quantity,
      sku: component.sku,
      name: component.name,
      category: component.category,
    });
    componentsByMapping.set(component.mappingId, list);
  }

  return {
    mappings: mappingRows.map((row) => ({ ...row, components: componentsByMapping.get(row.id) ?? [] })),
    items: itemRows,
  };
}

export interface ProductBundleComponentInput {
  inventoryItemId: string;
  quantity: number;
}

function validateBundleComponents(
  components: ProductBundleComponentInput[] | undefined,
): ProductBundleComponentInput[] {
  if (!components) return [];
  const seen = new Set<string>();
  const normalized = components.map((component) => ({
    inventoryItemId: typeof component?.inventoryItemId === "string" ? component.inventoryItemId.trim() : "",
    quantity: component?.quantity,
  }));
  for (const component of normalized) {
    if (!component || typeof component.inventoryItemId !== "string" || !component.inventoryItemId.trim()
      || !Number.isSafeInteger(component.quantity) || component.quantity <= 0) {
      throw new WmsError("invalid", "組合商品的用料與數量格式不正確。 ");
    }
    if (seen.has(component.inventoryItemId)) {
      throw new WmsError("invalid", "組合商品不可重複設定同一個 WMS 商品。 ");
    }
    seen.add(component.inventoryItemId);
  }
  return normalized;
}

export async function addProductSkuMapping(
  db: Database,
  input: {
    inventoryItemId: string;
    channel?: string;
    externalSku: string;
    components?: ProductBundleComponentInput[];
    actor: Actor;
  },
): Promise<{ id: string; channel: string; externalSku: string; components: ProductBundleComponentInput[] }> {
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
  const components = validateBundleComponents(input.components);
  const componentItems = components.length
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
      .from(inventoryItems)
      .where(inArray(inventoryItems.id, components.map((component) => component.inventoryItemId)))
    : [];
  if (componentItems.length !== components.length) {
    throw new WmsError("not_found", "找不到組合商品使用的 WMS 商品。 ");
  }
  if (componentItems.some((component) => !component.sku)) {
    throw new WmsError("invalid", "請先設定組合商品用料的 WMS SKU。 ");
  }

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
      const existingComponents = await db
        .select({ inventoryItemId: productBundleComponents.inventoryItemId, quantity: productBundleComponents.quantity })
        .from(productBundleComponents)
        .where(eq(productBundleComponents.mappingId, existing.id));
      return { id: existing.id, channel, externalSku, components: existingComponents };
    }
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經對應到其他商品。 `);
  }

  const id = crypto.randomUUID();
  await db.batch([
    db.insert(productSkuMappings).values({ id, inventoryItemId: input.inventoryItemId, channel, externalSku }),
    ...components.map((component) => db.insert(productBundleComponents).values({
      mappingId: id,
      inventoryItemId: component.inventoryItemId,
      quantity: component.quantity,
    })),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${item.sku} ${item.name}`,
      eventType: "product_sku_mapping_created",
      summary: `新增${channel} 外部 SKU 對應：${externalSku}${components.length ? `（${components.length} 個組合用料）` : ""}`,
      field: "externalSku",
      newValue: externalSku,
      actor: input.actor,
      source: "wms",
    })),
  ]);

  return { id, channel, externalSku, components };
}

export async function updateProductSkuMapping(
  db: Database,
  input: {
    id: string;
    inventoryItemId: string;
    channel?: string;
    externalSku: string;
    components?: ProductBundleComponentInput[];
    actor: Actor;
  },
): Promise<{ id: string; channel: string; externalSku: string; components: ProductBundleComponentInput[] }> {
  const channel = normalizeProductSkuChannel(input.channel ?? "legacy");
  if (!channel) throw new WmsError("invalid", "通路不可為空。 ");
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。 ");

  const [mapping] = await db
    .select({
      id: productSkuMappings.id,
      inventoryItemId: productSkuMappings.inventoryItemId,
      channel: productSkuMappings.channel,
      externalSku: productSkuMappings.externalSku,
      itemSku: inventoryItems.sku,
      itemName: inventoryItems.name,
    })
    .from(productSkuMappings)
    .innerJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
    .where(eq(productSkuMappings.id, input.id));
  if (!mapping) throw new WmsError("not_found", "找不到這筆外部 SKU 對應。 ");

  const [item] = await db
    .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, input.inventoryItemId));
  if (!item) throw new WmsError("not_found", "找不到這項商品。 ");
  if (!item.sku) throw new WmsError("invalid", "請先設定 WMS SKU，才能建立外部 SKU 對應。 ");

  const components = validateBundleComponents(input.components);
  const componentItems = components.length
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku })
      .from(inventoryItems)
      .where(inArray(inventoryItems.id, components.map((component) => component.inventoryItemId)))
    : [];
  if (componentItems.length !== components.length) {
    throw new WmsError("not_found", "找不到組合商品使用的 WMS 商品。 ");
  }
  if (componentItems.some((component) => !component.sku)) {
    throw new WmsError("invalid", "請先設定組合商品用料的 WMS SKU。 ");
  }

  const [skuOwner] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`UPPER(${inventoryItems.sku}) = ${externalSku}`)
    .limit(1);
  if (skuOwner && skuOwner.id !== input.inventoryItemId) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」與其他商品的 WMS SKU 衝突。 `);
  }

  const [existing] = await db
    .select({ id: productSkuMappings.id })
    .from(productSkuMappings)
    .where(and(
      eq(productSkuMappings.channel, channel),
      eq(productSkuMappings.externalSku, externalSku),
      ne(productSkuMappings.id, input.id),
    ))
    .limit(1);
  if (existing) {
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經對應到其他商品。 `);
  }

  await db.batch([
    db.update(productSkuMappings)
      .set({
        inventoryItemId: input.inventoryItemId,
        channel,
        externalSku,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(productSkuMappings.id, input.id)),
    db.delete(productBundleComponents).where(eq(productBundleComponents.mappingId, input.id)),
    ...(components.length ? [db.insert(productBundleComponents).values(components.map((component) => ({
      mappingId: input.id,
      inventoryItemId: component.inventoryItemId,
      quantity: component.quantity,
    })))] : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: input.id,
      entityLabel: `${item.sku} ${item.name}`,
      eventType: "product_sku_mapping_updated",
      summary: `更新${channel} 外部 SKU 對應：${externalSku}${components.length ? `（${components.length} 個組合用料）` : ""}`,
      field: mapping.externalSku === externalSku ? "mapping" : "externalSku",
      oldValue: mapping.externalSku,
      newValue: externalSku,
      payload: {
        before: {
          inventoryItemId: mapping.inventoryItemId,
          channel: mapping.channel,
          externalSku: mapping.externalSku,
        },
        after: {
          inventoryItemId: input.inventoryItemId,
          channel,
          externalSku,
          components,
        },
      },
      actor: input.actor,
      source: "wms",
    })),
  ]);

  return { id: input.id, channel, externalSku, components };
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
    id: string;
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
          id: productSkuMappings.id,
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

  const componentsByMapping = new Map<string, ResolvedProductSkuComponent[]>();
  const mappingIds = [...new Set(mappings.map((mapping) => mapping.id))];
  for (let offset = 0; offset < mappingIds.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = mappingIds.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    const componentRows = await db
      .select({
        mappingId: productBundleComponents.mappingId,
        inventoryItemId: productBundleComponents.inventoryItemId,
        sku: inventoryItems.sku,
        name: inventoryItems.name,
        category: inventoryItems.category,
        quantity: productBundleComponents.quantity,
      })
      .from(productBundleComponents)
      .innerJoin(inventoryItems, eq(inventoryItems.id, productBundleComponents.inventoryItemId))
      .where(inArray(productBundleComponents.mappingId, batch));
    for (const component of componentRows) {
      if (!component.sku) continue;
      const list = componentsByMapping.get(component.mappingId) ?? [];
      list.push({
        inventoryItemId: component.inventoryItemId,
        sku: component.sku,
        name: component.name,
        category: component.category,
        quantity: component.quantity,
      });
      componentsByMapping.set(component.mappingId, list);
    }
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
      components: [],
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
      components: componentsByMapping.get(mapping.id) ?? [],
    });
    resolvedChannels.set(key, mapping.channel);
  }
  return resolved;
}
