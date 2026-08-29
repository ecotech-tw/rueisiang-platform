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

/** 蝦皮新報表會把規格 ID 接在商品 ID 後；舊 mapping 仍可能只有商品 ID。 */
function legacyShopeeExternalSku(value: string): string {
  const separator = value.indexOf("_");
  return separator > 0 ? value.slice(0, separator) : "";
}

export interface ProductSkuMappingRow {
  id: string;
  inventoryItemId: string | null;
  channel: string;
  systemSku: string | null;
  externalName: string;
  externalSku: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSkuMappingManagementRow extends ProductSkuMappingRow {
  itemSku: string | null;
  itemName: string | null;
  itemCategory: string | null;
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
  /** 沒有 WMS 主商品的 mapping 以 system SKU 作為報表商品本身，不展開成第一個用料。 */
  isCustom: boolean;
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

async function requireCustomSystemSkuAvailable(db: Database, systemSku: string) {
  const [owner] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`UPPER(${inventoryItems.sku}) = ${systemSku}`)
    .limit(1);
  if (owner) {
    throw new WmsError("conflict", `自訂系統 SKU「${systemSku}」已是 WMS 商品 SKU，請改用 WMS 商品對應。`);
  }
}

/**
 * SKU 對應管理頁需要的兩份資料。
 *
 * 通路商品名稱存於 mapping；正式 SKU、WMS 商品名稱與分類則從 inventory_items 讀取，
 * 避免管理頁顯示一份過期的複本。items 只供新增 mapping 時選擇，不包含倉位、數量或
 * 其他不相關的倉儲資料。
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
        systemSku: productSkuMappings.systemSku,
        externalName: productSkuMappings.externalName,
        externalSku: productSkuMappings.externalSku,
        createdAt: productSkuMappings.createdAt,
        updatedAt: productSkuMappings.updatedAt,
        itemSku: inventoryItems.sku,
        itemName: inventoryItems.name,
        itemCategory: inventoryItems.category,
        itemCategoryColor: productCategories.color,
      })
      .from(productSkuMappings)
      .leftJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
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
      .orderBy(asc(productBundleComponents.mappingId), asc(inventoryItems.name), asc(inventoryItems.id)));
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
      throw new WmsError("invalid", "組合商品的用料與數量格式不正確。");
    }
    if (seen.has(component.inventoryItemId)) {
      throw new WmsError("invalid", "組合商品不可重複設定同一個 WMS 商品。");
    }
    seen.add(component.inventoryItemId);
  }
  return normalized;
}

export async function addProductSkuMapping(
  db: Database,
  input: {
    inventoryItemId?: string | null;
    channel?: string;
    systemSku?: string | null;
    externalName?: string;
    externalSku: string;
    components?: ProductBundleComponentInput[];
    actor: Actor;
  },
): Promise<{ id: string; channel: string; systemSku: string; externalName: string; externalSku: string; components: ProductBundleComponentInput[] }> {
  const channel = normalizeProductSkuChannel(input.channel ?? "legacy");
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  const requestedSystemSku = typeof input.systemSku === "string"
    ? normalizeExternalSku(input.systemSku)
    : "";
  if (input.systemSku !== undefined && input.systemSku !== null && !requestedSystemSku) {
    throw new WmsError("invalid", "系統 SKU 不可為空。");
  }

  const requestedComponents = validateBundleComponents(input.components);
  const components = requestedComponents.length
    ? requestedComponents
    : input.inventoryItemId
      ? [{ inventoryItemId: input.inventoryItemId, quantity: 1 }]
      : [];
  if (!components.length) throw new WmsError("invalid", "至少要設定一個組合用料。");
  const firstComponent = components[0];
  if (!firstComponent) throw new WmsError("invalid", "至少要設定一個組合用料。");
  const inventoryItemId = input.inventoryItemId === undefined
    ? firstComponent.inventoryItemId
    : input.inventoryItemId;
  if (inventoryItemId && !components.some((component) => component.inventoryItemId === inventoryItemId)) {
    throw new WmsError("invalid", "WMS 主商品必須同時列在組合用料中。若沒有 WMS 主商品，請選擇自訂 SKU。 ");
  }

  const [item] = inventoryItemId
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, inventoryItemId))
    : [];
  if (inventoryItemId && !item) throw new WmsError("not_found", "找不到這項商品。");
  if (item && !item.sku) throw new WmsError("invalid", "請先設定 WMS SKU，才能建立外部 SKU 對應。");
  if (inventoryItemId && requestedSystemSku && item && normalizeExternalSku(item.sku ?? "") !== requestedSystemSku) {
    throw new WmsError("invalid", "WMS 商品的系統 SKU 會直接使用 WMS SKU，不能另外指定。");
  }
  const systemSku = inventoryItemId
    ? normalizeExternalSku(item?.sku ?? "")
    : requestedSystemSku;
  if (!systemSku) throw new WmsError("invalid", "自訂 SKU 對應必須填寫系統 SKU。");
  if (!inventoryItemId) await requireCustomSystemSkuAvailable(db, systemSku);
  const componentItems = components.length
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
      .from(inventoryItems)
      .where(inArray(inventoryItems.id, components.map((component) => component.inventoryItemId)))
    : [];
  if (componentItems.length !== components.length) {
    throw new WmsError("not_found", "找不到組合商品使用的 WMS 商品。");
  }
  if (componentItems.some((component) => !component.sku)) {
    throw new WmsError("invalid", "請先設定組合商品用料的 WMS SKU。");
  }

  /*
   * 外部 SKU 撞到「這筆 mapping 以外」的 WMS SKU 才算衝突。
   *
   * 只比主商品的話，組合的外部 SKU 剛好等於某個非第一順位用料的 WMS SKU 就會被誤擋；
   * 而 resolveProductSkus 本來就讓明確 mapping 贏過 implicit 的直接商品比對，那裡沒有歧義。
   */
  const mappedItemIds = new Set([
    ...(inventoryItemId ? [inventoryItemId] : []),
    ...components.map((component) => component.inventoryItemId),
  ]);
  const skuOwners = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`UPPER(${inventoryItems.sku}) = ${externalSku}`);
  if (skuOwners.some((owner) => !mappedItemIds.has(owner.id))) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」與其他商品的 WMS SKU 衝突。`);
  }

  const externalName = input.externalName === undefined ? item?.name ?? "" : input.externalName.trim();
  if (!externalName) throw new WmsError("invalid", "通路商品名稱不可為空。");

  const [existing] = await db
    .select({ id: productSkuMappings.id })
    .from(productSkuMappings)
    .where(and(
      eq(productSkuMappings.channel, channel),
      eq(productSkuMappings.externalSku, externalSku),
    ))
    .limit(1);
  if (existing) {
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經存在，請改用編輯功能。`);
  }

  const id = crypto.randomUUID();
  await db.batch([
    db.insert(productSkuMappings).values({
      id,
      inventoryItemId,
      channel,
      systemSku,
      externalName,
      externalSku,
    }),
    ...components.map((component) => db.insert(productBundleComponents).values({
      mappingId: id,
      inventoryItemId: component.inventoryItemId,
      quantity: component.quantity,
    })),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: item ? `${item.sku} ${item.name}` : externalName,
      eventType: "product_sku_mapping_created",
      summary: `新增${channel} 外部 SKU 對應：${externalSku}${components.length ? `（${components.length} 個組合用料）` : ""}`,
      field: "externalSku",
      newValue: externalSku,
      actor: input.actor,
      source: "wms",
    })),
  ]);

  return { id, channel, systemSku, externalName, externalSku, components };
}

export async function updateProductSkuMapping(
  db: Database,
  input: {
    id: string;
    inventoryItemId?: string | null;
    channel?: string;
    systemSku?: string | null;
    externalName: string;
    externalSku: string;
    components?: ProductBundleComponentInput[];
    actor: Actor;
  },
): Promise<{ id: string; channel: string; systemSku: string; externalName: string; externalSku: string; components: ProductBundleComponentInput[] }> {
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  const requestedSystemSku = typeof input.systemSku === "string"
    ? normalizeExternalSku(input.systemSku)
    : "";
  if (input.systemSku !== undefined && input.systemSku !== null && !requestedSystemSku) {
    throw new WmsError("invalid", "系統 SKU 不可為空。");
  }
  const externalName = input.externalName.trim();
  if (!externalName) throw new WmsError("invalid", "通路商品名稱不可為空。");
  const components = validateBundleComponents(input.components);
  if (!components.length) throw new WmsError("invalid", "至少要設定一個組合用料。");
  const firstComponent = components[0];
  if (!firstComponent) throw new WmsError("invalid", "至少要設定一個組合用料。");

  const [mapping] = await db
    .select({
      id: productSkuMappings.id,
      inventoryItemId: productSkuMappings.inventoryItemId,
      channel: productSkuMappings.channel,
      systemSku: productSkuMappings.systemSku,
      externalName: productSkuMappings.externalName,
      externalSku: productSkuMappings.externalSku,
      itemSku: inventoryItems.sku,
      itemName: inventoryItems.name,
    })
    .from(productSkuMappings)
    .leftJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
    .where(eq(productSkuMappings.id, input.id));
  if (!mapping) throw new WmsError("not_found", "找不到這筆外部 SKU 對應。");

  const channel = normalizeProductSkuChannel(input.channel ?? mapping.channel);
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  // 編輯時保留原本的主商品，只在主商品被移出用料時才改用新的第一個用料。
  // 這樣管理頁依名稱排序後重新儲存，不會悄悄改變刪除保護與代表商品。
  const inventoryItemId = input.inventoryItemId !== undefined
    ? input.inventoryItemId
    : mapping.inventoryItemId === null
      ? null
      : components.some((component) => component.inventoryItemId === mapping.inventoryItemId)
        ? mapping.inventoryItemId
        : firstComponent.inventoryItemId;

  if (inventoryItemId && !components.some((component) => component.inventoryItemId === inventoryItemId)) {
    throw new WmsError("invalid", "WMS 主商品必須同時列在組合用料中。若沒有 WMS 主商品，請選擇自訂 SKU。 ");
  }

  const [item] = inventoryItemId
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, inventoryItemId))
    : [];
  if (inventoryItemId && !item) throw new WmsError("not_found", "找不到這項商品。");
  if (item && !item.sku) throw new WmsError("invalid", "請先設定 WMS SKU，才能建立外部 SKU 對應。");
  if (inventoryItemId && requestedSystemSku && item && normalizeExternalSku(item.sku ?? "") !== requestedSystemSku) {
    throw new WmsError("invalid", "WMS 商品的系統 SKU 會直接使用 WMS SKU，不能另外指定。");
  }
  /*
   * 從 WMS 對應轉成自訂時一定要明確給 system SKU。
   *
   * 沿用 mapping.systemSku 當預設值的話，拿到的是舊 WMS 商品的 SKU，接著必定被
   * requireCustomSystemSkuAvailable 以「已是 WMS 商品 SKU」擋下——使用者看到的錯誤
   * 跟他做的事對不起來，而且欄位是系統自己填的。
   */
  const wasCustom = mapping.inventoryItemId === null;
  const systemSku = inventoryItemId
    ? normalizeExternalSku(item?.sku ?? "")
    : requestedSystemSku || (wasCustom ? normalizeExternalSku(mapping.systemSku ?? "") : "");
  if (!systemSku) throw new WmsError("invalid", "自訂 SKU 對應必須填寫系統 SKU。");
  if (!inventoryItemId) await requireCustomSystemSkuAvailable(db, systemSku);

  const componentItems = components.length
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku })
      .from(inventoryItems)
      .where(inArray(inventoryItems.id, components.map((component) => component.inventoryItemId)))
    : [];
  if (componentItems.length !== components.length) {
    throw new WmsError("not_found", "找不到組合商品使用的 WMS 商品。");
  }
  if (componentItems.some((component) => !component.sku)) {
    throw new WmsError("invalid", "請先設定組合商品用料的 WMS SKU。");
  }

  /*
   * 外部 SKU 撞到「這筆 mapping 以外」的 WMS SKU 才算衝突。
   *
   * 只比主商品的話，組合的外部 SKU 剛好等於某個非第一順位用料的 WMS SKU 就會被誤擋；
   * 而 resolveProductSkus 本來就讓明確 mapping 贏過 implicit 的直接商品比對，那裡沒有歧義。
   */
  const mappedItemIds = new Set([
    ...(inventoryItemId ? [inventoryItemId] : []),
    ...components.map((component) => component.inventoryItemId),
  ]);
  const skuOwners = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`UPPER(${inventoryItems.sku}) = ${externalSku}`);
  if (skuOwners.some((owner) => !mappedItemIds.has(owner.id))) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」與其他商品的 WMS SKU 衝突。`);
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
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經對應到其他商品。`);
  }

  await db.batch([
    db.update(productSkuMappings)
      .set({
        inventoryItemId,
        channel,
        systemSku,
        externalName,
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
      entityLabel: item ? `${item.sku} ${item.name}` : externalName,
      eventType: "product_sku_mapping_updated",
      summary: `更新${channel} 外部 SKU 對應：${externalSku}${components.length ? `（${components.length} 個組合用料）` : ""}`,
      field: mapping.externalSku === externalSku ? "mapping" : "externalSku",
      oldValue: mapping.externalSku,
      newValue: externalSku,
      payload: {
        before: {
          inventoryItemId: mapping.inventoryItemId,
          channel: mapping.channel,
          systemSku: mapping.systemSku,
          externalName: mapping.externalName,
          externalSku: mapping.externalSku,
        },
        after: {
          inventoryItemId,
          channel,
          systemSku,
          externalName,
          externalSku,
          components,
        },
      },
      actor: input.actor,
      source: "wms",
    })),
  ]);

  return { id: input.id, channel, systemSku, externalName, externalSku, components };
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
    .leftJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
    .where(eq(productSkuMappings.id, id));
  if (!mapping) throw new WmsError("not_found", "找不到這筆外部 SKU 對應。");

  await db.batch([
    db.delete(productSkuMappings).where(eq(productSkuMappings.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${mapping.itemSku ?? ""} ${mapping.itemName ?? mapping.externalSku}`.trim(),
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
  const lookupWanted = [...new Set([
    ...wanted,
    ...(normalizedChannel === "shopee" ? wanted.map(legacyShopeeExternalSku).filter(Boolean) : []),
  ])];
  const lookupChannels = [...new Set([normalizedChannel, "legacy"])] as string[];

  type MappingLookup = {
    id: string;
    externalSku: string;
    channel: string;
    systemSku: string | null;
    externalName: string;
    inventoryItemId: string | null;
    sku: string | null;
    name: string | null;
    category: string | null;
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
  for (let offset = 0; offset < lookupWanted.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = lookupWanted.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    const [batchMappings, batchDirectItems] = await Promise.all([
      db
        .select({
          id: productSkuMappings.id,
          externalSku: productSkuMappings.externalSku,
          channel: productSkuMappings.channel,
          systemSku: productSkuMappings.systemSku,
          externalName: productSkuMappings.externalName,
          inventoryItemId: productSkuMappings.inventoryItemId,
          sku: inventoryItems.sku,
          name: inventoryItems.name,
          category: inventoryItems.category,
        })
        .from(productSkuMappings)
        .leftJoin(inventoryItems, eq(inventoryItems.id, productSkuMappings.inventoryItemId))
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
  const incompleteMappings = new Set<string>();
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
      .where(inArray(productBundleComponents.mappingId, batch))
      // 管理頁依商品名稱排序料件，這裡照做：金額要落在哪個料件上不能取決於 SQLite 的回傳順序。
      .orderBy(asc(productBundleComponents.mappingId), asc(inventoryItems.name), asc(inventoryItems.id));
    for (const component of componentRows) {
      /*
       * 料件沒有 WMS SKU 就整筆 mapping 視為無法解析，不是跳過那個料件。
       *
       * 跳過的話數量會憑空少掉而且不會有任何訊號——這個功能其他地方對「解析不出商品」
       * 一律是大聲的 422。0057 的回填會替每一筆舊 mapping 補一列料件，不管商品有沒有
       * SKU，所以舊資料真的會走到這裡。
       */
      if (!component.sku) {
        incompleteMappings.add(component.mappingId);
        continue;
      }
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
      isCustom: false,
      components: [],
    });
  }
  for (const mapping of mappings) {
    if (incompleteMappings.has(mapping.id)) continue;
    const components = componentsByMapping.get(mapping.id) ?? [];
    const firstComponent = components[0];
    const isCustom = mapping.inventoryItemId === null;
    // WMS mapping 的正式 SKU 來源是 inventory_items；system_sku 只作為自訂 mapping 的明確識別。
    const sku = isCustom
      ? mapping.systemSku ?? mapping.sku ?? firstComponent?.sku
      : mapping.sku ?? firstComponent?.sku;
    const name = mapping.name || mapping.externalName || firstComponent?.name;
    /*
     * 自訂 mapping 沒有自己的分類，只能沿用排序最前面那個用料的分類。
     *
     * 這會失真：一個禮盒若第一個用料是外盒，就會被歸到「包裝材料」，query_sales_report
     * 的分類篩選跟著錯，而且用料改名（排序變了）分類還會跟著變。要修正得讓
     * product_sku_mappings 自己帶一個分類欄位，那是一次 schema 變更，先記在這裡。
     */
    const category = mapping.category ?? firstComponent?.category;
    const inventoryItemId = mapping.inventoryItemId ?? firstComponent?.inventoryItemId;
    if (!sku || !name || !category || !inventoryItemId) continue;
    const key = normalizeExternalSku(mapping.externalSku);
    const previous = resolved.get(key);
    if (previous && resolvedChannels.get(key) === normalizedChannel && mapping.channel !== normalizedChannel) continue;
    resolved.set(key, {
      inventoryItemId,
      sku,
      name,
      category,
      isCustom,
      components,
    });
    resolvedChannels.set(key, mapping.channel);
  }
  if (normalizedChannel === "shopee") {
    for (const key of wanted) {
      if (resolved.has(key)) continue;
      const legacyKey = legacyShopeeExternalSku(key);
      const fallback = legacyKey ? resolved.get(legacyKey) : undefined;
      if (fallback) resolved.set(key, fallback);
    }
  }
  return resolved;
}
