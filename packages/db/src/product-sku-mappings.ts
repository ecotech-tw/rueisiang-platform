import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { formatCyberbizProductName } from "./cyberbiz-product-name.js";
import { activityEvents } from "./schema/activity.js";
import { itemCategories, itemComponents, cyberbizProducts, items as itemMasters } from "./schema/items.js";
import { reportExternalProducts, reportIngestIssues, reportRuns } from "./schema/reports.js";
import { wmsItems } from "./schema/wms.js";
import { WmsError, type Actor } from "./wms.js";

/** 外部 SKU 寫入前統一格式，避免大小寫造成兩筆 mapping。 */
export function normalizeExternalSku(value: string): string {
  return value.trim().toUpperCase();
}

/** 通路目前用文字保存；先統一大小寫，未來新增通路不用先改資料庫 enum。 */
export function normalizeProductSkuChannel(value: string): string {
  return value.trim().toLowerCase();
}

/** 從 scope ID 前綴推導這個 scope 自己的通路；沒有前綴的資料當作未指定通路。 */
export function scopeChannelFromId(scopeId: string): string {
  const [prefix, scopePart] = scopeId.split(":", 2);
  if (!scopePart) return "legacy";
  return normalizeProductSkuChannel(prefix ?? "") || "legacy";
}

/** manual scope 的資料仍然是 CYBERBIZ 報表。 */
export function dataChannelFromScopeId(scopeId: string): string {
  const channel = scopeChannelFromId(scopeId);
  return channel === "manual" ? "cyberbiz" : channel;
}

/** 蝦皮報表的商品 ID_規格 ID 格式；仍可用來支援輸入檔的外部鍵。 */
export function shopeeBaseExternalSku(value: string): string {
  const separator = value.indexOf("_");
  return separator > 0 ? value.slice(0, separator) : "";
}

export interface ProductSkuMappingRow {
  id: string;
  channel: string;
  externalName: string;
  externalSku: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSkuMappingManagementRow extends ProductSkuMappingRow {
  components: ProductBundleComponentManagementRow[];
}

export interface ProductBundleComponentManagementRow {
  /** target schema 的 item id；所有新的 SKU 對應都直接保存這個 ID。 */
  itemId: string;
  /** 舊 API/UI 使用的 WMS item id；新資料以 itemId 為準。 */
  source: "item" | "cyberbiz" | "custom";
  inventoryItemId: string | null;
  cyberbizSku: string | null;
  customProductId: string | null;
  sku: string;
  name: string;
  category: string;
  quantity: number;
}

export interface ProductSkuMappingItemOption {
  id: string;
  sku: string;
  name: string;
  category: string;
}

export interface UnmappedProductOption {
  channel: string;
  externalSku: string;
  externalName: string;
  rowCount: number;
  lastSeenAt: string;
}

export interface ProductSkuMappingManagementData {
  mappings: ProductSkuMappingManagementRow[];
  categories: string[];
  /** 可直接作為 mapping 用料的 target item；包含 WMS 品項與 CYBERBIZ 鏡像，不包含未入庫自訂品項。 */
  items: ProductSkuMappingItemOption[];
  /** 從最近匯入問題彙整，並排除已經有 mapping／ignore 的外部 SKU。 */
  unmappedProducts: UnmappedProductOption[];
}

export interface ResolvedProductSku {
  externalName: string;
  components: ResolvedProductSkuComponent[];
}

export interface ResolvedProductSkuComponent {
  /** 只有實際納入 WMS 的 target item 才填這個欄位。 */
  inventoryItemId: string | null;
  sku: string;
  name: string;
  category: string;
  quantity: number;
}

const SKU_LOOKUP_BATCH_SIZE = 50;

async function inBatches<T, R>(values: T[], run: (batch: T[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    results.push(...await run(values.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE)));
  }
  return results;
}

async function categoryNames(db: Database): Promise<Map<string, string>> {
  const rows = await db.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories);
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function loadTargetProductSkuMappingManagement(db: Database): Promise<ProductSkuMappingManagementData> {
  const [rows, categories, wmsRows, cyberbizRows, unmappedRows, resolvedRows] = await Promise.all([
    db.select({
      id: reportExternalProducts.id,
      channel: reportExternalProducts.sourceType,
      externalName: reportExternalProducts.externalName,
      externalSku: reportExternalProducts.externalKey,
      createdAt: reportExternalProducts.createdAt,
      updatedAt: reportExternalProducts.updatedAt,
      itemId: reportExternalProducts.itemId,
      itemSource: itemMasters.source,
      sku: itemMasters.sku,
      itemName: itemMasters.name,
      itemCategoryId: itemMasters.categoryId,
    })
      .from(reportExternalProducts)
      .innerJoin(itemMasters, eq(itemMasters.id, reportExternalProducts.itemId))
      .where(eq(reportExternalProducts.resolution, "mapped"))
      .orderBy(asc(reportExternalProducts.sourceType), asc(reportExternalProducts.externalKey)),
    db.select({ id: itemCategories.id, name: itemCategories.name })
      .from(itemCategories)
      .orderBy(asc(itemCategories.name)),
    db.select({ itemId: wmsItems.itemId, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId })
      .from(wmsItems)
      .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
      .orderBy(asc(itemMasters.name), asc(itemMasters.sku)),
    db.select({ id: itemMasters.id, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId })
      .from(itemMasters)
      .where(eq(itemMasters.source, "cyberbiz"))
      .orderBy(asc(itemMasters.name), asc(itemMasters.sku)),
    db.select({
      channel: reportRuns.sourceType,
      externalSku: reportIngestIssues.externalKey,
      externalName: reportIngestIssues.externalName,
      rowCount: reportIngestIssues.rowCount,
      lastSeenAt: reportRuns.createdAt,
    })
      .from(reportIngestIssues)
      .innerJoin(reportRuns, eq(reportRuns.id, reportIngestIssues.reportRunId))
      .where(eq(reportIngestIssues.issueType, "unmapped"))
      .orderBy(desc(reportRuns.createdAt)),
    db.select({ channel: reportExternalProducts.sourceType, externalSku: reportExternalProducts.externalKey })
      .from(reportExternalProducts),
  ]);
  const categoryById = new Map(categories.map((category) => [category.id, category.name]));
  const wmsIds = new Set(wmsRows.map((row) => row.itemId));
  const itemOptions = new Map<string, ProductSkuMappingItemOption>();
  for (const row of wmsRows) {
    itemOptions.set(row.itemId, {
      id: row.itemId,
      sku: row.sku,
      name: row.name || row.sku,
      category: categoryById.get(row.categoryId ?? "") ?? "未分類",
    });
  }
  for (const row of cyberbizRows) {
    if (!itemOptions.has(row.id)) {
      itemOptions.set(row.id, {
        id: row.id,
        sku: row.sku,
        name: row.name || row.sku,
        category: categoryById.get(row.categoryId ?? "") ?? "未分類",
      });
    }
  }
  const resolvedKeys = new Set(resolvedRows.map((row) => `${normalizeProductSkuChannel(row.channel)}\u0000${normalizeExternalSku(row.externalSku)}`));
  const unmappedByKey = new Map<string, UnmappedProductOption>();
  for (const row of unmappedRows) {
    const externalSku = normalizeExternalSku(row.externalSku);
    const key = `${normalizeProductSkuChannel(row.channel)}\u0000${externalSku}`;
    if (!externalSku || resolvedKeys.has(key) || unmappedByKey.has(key)) continue;
    unmappedByKey.set(key, {
      channel: normalizeProductSkuChannel(row.channel),
      externalSku,
      externalName: row.externalName.trim(),
      rowCount: row.rowCount,
      lastSeenAt: row.lastSeenAt,
    });
  }
  const parentIds = rows.map((row) => row.itemId).filter((id): id is string => !!id);
  const componentRows = await inBatches(parentIds, (batch) => db
    .select({ parentItemId: itemComponents.parentItemId, componentItemId: itemComponents.componentItemId, quantity: itemComponents.quantity })
    .from(itemComponents)
    .where(inArray(itemComponents.parentItemId, batch))
    .orderBy(asc(itemComponents.parentItemId), sql`rowid`));
  const componentIds = [...new Set(componentRows.map((row) => row.componentItemId))];
  const componentItems = await inBatches(componentIds, (batch) => db
    .select({ id: itemMasters.id, source: itemMasters.source, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId })
    .from(itemMasters)
    .where(inArray(itemMasters.id, batch)));
  const componentById = new Map(componentItems.map((row) => [row.id, row]));
  const componentsByParent = new Map<string, typeof componentRows>();
  for (const row of componentRows) {
    const list = componentsByParent.get(row.parentItemId) ?? [];
    list.push(row);
    componentsByParent.set(row.parentItemId, list);
  }
  const managementComponent = (row: {
    id: string;
    source: "cyberbiz" | "custom";
    sku: string;
    name: string;
    categoryId: string | null;
    quantity: number;
  }): ProductBundleComponentManagementRow => ({
    itemId: row.id,
    source: row.source === "cyberbiz" ? "cyberbiz" : wmsIds.has(row.id) ? "item" : "custom",
    inventoryItemId: wmsIds.has(row.id) ? row.id : null,
    cyberbizSku: row.source === "cyberbiz" ? row.sku : null,
    customProductId: row.source !== "cyberbiz" && !wmsIds.has(row.id) ? row.id : null,
    sku: row.sku,
    name: row.name,
    category: categoryById.get(row.categoryId ?? "") ?? "未分類",
    quantity: row.quantity,
  });
  return {
    items: [...itemOptions.values()],
    unmappedProducts: [...unmappedByKey.values()],
    mappings: rows.map((row) => {
      const children = (componentsByParent.get(row.itemId ?? "") ?? [])
        .map((component) => {
          const item = componentById.get(component.componentItemId);
          return item ? managementComponent({ ...item, quantity: component.quantity }) : null;
        })
        .filter((component): component is ProductBundleComponentManagementRow => component !== null);
      const direct = row.itemSource && row.sku && row.itemName
        ? managementComponent({ id: row.itemId!, source: row.itemSource, sku: row.sku, name: row.itemName, categoryId: row.itemCategoryId, quantity: 1 })
        : null;
      return {
        id: row.id,
        channel: row.channel,
        externalName: row.externalName,
        externalSku: row.externalSku,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        components: children.length ? children : direct ? [direct] : [],
      };
    }),
    categories: categories.map((row) => row.name),
  };
}

export async function loadProductSkuMappingManagement(db: Database): Promise<ProductSkuMappingManagementData> {
  return loadTargetProductSkuMappingManagement(db);
}

export interface ProductBundleComponentInput {
  /** target items.id；新的 SKU 對應直接使用全平台品項主檔。 */
  itemId?: string | null;
  /** 舊版 API 的 target wms_items.item_id，保留給既有資料與相容性。 */
  inventoryItemId?: string | null;
  cyberbizSku?: string | null;
  customSku?: string | null;
  customName?: string | null;
  customCategory?: string | null;
  quantity: number;
}

interface NormalizedComponent {
  itemId: string | null;
  inventoryItemId: string | null;
  cyberbizSku: string | null;
  customSku: string | null;
  customName: string;
  customCategory: string;
  quantity: number;
}

function validateBundleComponents(components: ProductBundleComponentInput[] | undefined): NormalizedComponent[] {
  if (!components?.length) throw new WmsError("invalid", "至少要設定一個組合用料。");
  const seenItems = new Set<string>();
  const seenCyberbiz = new Set<string>();
  const seenCustom = new Set<string>();
  return components.map((component) => {
    const itemId = typeof component?.itemId === "string" ? component.itemId.trim() : "";
    const inventoryItemId = typeof component?.inventoryItemId === "string" ? component.inventoryItemId.trim() : "";
    const cyberbizSku = typeof component?.cyberbizSku === "string" ? normalizeExternalSku(component.cyberbizSku) : "";
    const customSku = typeof component?.customSku === "string" ? normalizeExternalSku(component.customSku) : "";
    if (!Number.isSafeInteger(component?.quantity) || component.quantity <= 0) {
      throw new WmsError("invalid", "組合用料的數量必須是大於 0 的整數。");
    }
    if ([itemId, inventoryItemId, cyberbizSku, customSku].filter(Boolean).length !== 1) {
      throw new WmsError("invalid", "每一列組合用料只能選擇一個品項。");
    }
    if (itemId) {
      if (seenItems.has(itemId)) throw new WmsError("invalid", "組合用料不可重複設定同一個品項。");
      seenItems.add(itemId);
      return { itemId, inventoryItemId: null, cyberbizSku: null, customSku: null, customName: "", customCategory: "", quantity: component.quantity };
    }
    if (inventoryItemId) {
      if (seenItems.has(inventoryItemId)) throw new WmsError("invalid", "組合用料不可重複設定同一個 WMS 商品。");
      seenItems.add(inventoryItemId);
      return { itemId: null, inventoryItemId, cyberbizSku: null, customSku: null, customName: "", customCategory: "", quantity: component.quantity };
    }
    if (cyberbizSku) {
      if (seenCyberbiz.has(cyberbizSku)) throw new WmsError("invalid", "組合用料不可重複設定同一個 CYBERBIZ 商品。");
      seenCyberbiz.add(cyberbizSku);
      return { itemId: null, inventoryItemId: null, cyberbizSku, customSku: null, customName: "", customCategory: "", quantity: component.quantity };
    }
    if (seenCustom.has(customSku)) throw new WmsError("invalid", "組合用料不可重複設定同一個自訂 SKU。");
    seenCustom.add(customSku);
    const customName = (component.customName ?? "").trim();
    if (!customName) throw new WmsError("invalid", `自訂 SKU「${customSku}」必須填寫商品名稱。`);
    return {
      inventoryItemId: null,
      cyberbizSku: null,
      itemId: null,
      customSku,
      customName,
      customCategory: (component.customCategory ?? "").trim() || "未分類",
      quantity: component.quantity,
    };
  });
}

async function requireExternalSkuAvailable(
  db: Database,
  externalSku: string,
  componentItemIds: string[],
  customProductSkus: string[],
): Promise<void> {
  const owners = await db.select({ id: itemMasters.id })
    .from(wmsItems)
    .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
    .where(sql`UPPER(${itemMasters.sku}) = ${externalSku}`);
  const allowed = new Set(componentItemIds);
  if (owners.some((owner) => !allowed.has(owner.id))) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」與其他商品的 WMS SKU 衝突。`);
  }
  const [customOwner] = await db.select({ sku: itemMasters.sku, name: itemMasters.name })
    .from(itemMasters)
    .where(and(eq(itemMasters.source, "custom"), sql`UPPER(${itemMasters.sku}) = ${externalSku}`))
    .limit(1);
  if (customOwner && !customProductSkus.includes(normalizeExternalSku(customOwner.sku))) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」已是自訂商品主檔「${customOwner.name}」的系統 SKU，請換一個外部 SKU。`);
  }
}

async function requireTargetMappingItem(db: Database, component: NormalizedComponent): Promise<string> {
  if (component.itemId) {
    const [item] = await db.select({ id: itemMasters.id, source: itemMasters.source })
      .from(itemMasters)
      .where(eq(itemMasters.id, component.itemId))
      .limit(1);
    if (!item) throw new WmsError("not_found", "找不到對應的品項。");
    if (item.source !== "cyberbiz") {
      const [wmsItem] = await db.select({ itemId: wmsItems.itemId })
        .from(wmsItems)
        .where(eq(wmsItems.itemId, item.id))
        .limit(1);
      if (!wmsItem) throw new WmsError("invalid", "SKU 對應只能選擇 CYBERBIZ 品項或已納入 WMS 的品項。");
    }
    return item.id;
  }
  if (component.inventoryItemId) {
    const [item] = await db.select({ id: itemMasters.id })
      .from(wmsItems)
      .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
      .where(eq(wmsItems.itemId, component.inventoryItemId))
      .limit(1);
    if (!item) throw new WmsError("not_found", "找不到組合用料使用的 WMS 商品。");
    return item.id;
  }
  if (component.cyberbizSku) {
    const [item] = await db.select({ id: itemMasters.id })
      .from(itemMasters)
      .where(and(eq(itemMasters.source, "cyberbiz"), eq(itemMasters.sku, component.cyberbizSku)))
      .limit(1);
    if (!item) throw new WmsError("not_found", `CYBERBIZ 目錄裡找不到 SKU「${component.cyberbizSku}」，請先同步官網商品目錄。`);
    return item.id;
  }
  if (!component.customSku) throw new WmsError("invalid", "自訂 SKU 不可為空。");
  const [existing] = await db.select({ id: itemMasters.id, categoryId: itemMasters.categoryId })
    .from(itemMasters)
    .where(and(eq(itemMasters.source, "custom"), eq(itemMasters.sku, component.customSku)))
    .limit(1);
  const [category] = component.customCategory !== "未分類"
    ? await db.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.name, component.customCategory)).limit(1)
    : [];
  const categoryId = category?.id ?? null;
  if (existing) {
    await db.update(itemMasters).set({
      name: component.customName,
      categoryId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(eq(itemMasters.id, existing.id));
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db.insert(itemMasters).values({ id, source: "custom", kind: "sellable", sku: component.customSku, name: component.customName, categoryId, active: 1 });
  return id;
}

function targetBundleItemId(mappingId: string): string {
  return `report-bundle:${mappingId}`;
}

function targetBundleSku(mappingId: string): string {
  return `REPORT-BUNDLE:${mappingId}`.toUpperCase();
}

async function prepareTargetComponentItems(db: Database, components: NormalizedComponent[]): Promise<string[]> {
  return Promise.all(components.map((component) => requireTargetMappingItem(db, component)));
}

async function ensureTargetBundleItem(db: Database, mappingId: string, name: string, now: string): Promise<string> {
  const id = targetBundleItemId(mappingId);
  await db.insert(itemMasters).values({
    id,
    source: "custom",
    kind: "sellable",
    sku: targetBundleSku(mappingId),
    name,
    categoryId: null,
    active: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: itemMasters.id, set: { name, updatedAt: now } });
  return id;
}

async function addTargetProductSkuMapping(
  db: Database,
  input: { channel?: string; externalName: string; externalSku: string; components: ProductBundleComponentInput[]; actor: Actor },
) {
  const channel = normalizeProductSkuChannel(input.channel ?? "legacy");
  const externalSku = normalizeExternalSku(input.externalSku);
  const externalName = input.externalName.trim();
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  if (!externalName) throw new WmsError("invalid", "通路商品名稱不可為空。");
  const components = validateBundleComponents(input.components);
  await requireExternalSkuAvailable(db, externalSku,
    components.map((component) => component.itemId ?? component.inventoryItemId).filter((id): id is string => !!id),
    components.map((component) => component.customSku).filter((sku): sku is string => !!sku));
  const [existing] = await db.select({ id: reportExternalProducts.id, resolution: reportExternalProducts.resolution })
    .from(reportExternalProducts)
    .where(and(eq(reportExternalProducts.sourceType, channel), eq(reportExternalProducts.externalKey, externalSku), eq(reportExternalProducts.externalVariantKey, "")))
    .limit(1);
  if (existing?.resolution === "mapped") throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經存在，請改用編輯功能。`);

  const id = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const componentItemIds = await prepareTargetComponentItems(db, components);
  const useBundle = components.length !== 1 || components[0]!.quantity !== 1;
  const itemId = useBundle ? await ensureTargetBundleItem(db, id, externalName, now) : componentItemIds[0]!;
  const bundleRows = useBundle ? componentItemIds.map((componentItemId, index) => ({
    parentItemId: itemId,
    componentItemId,
    quantity: components[index]!.quantity,
    createdAt: now,
    updatedAt: now,
  })) : [];
  await db.batch([
    db.delete(itemComponents).where(eq(itemComponents.parentItemId, targetBundleItemId(id))),
    ...(bundleRows.length ? [db.insert(itemComponents).values(bundleRows)] : []),
    existing
      ? db.update(reportExternalProducts).set({ externalName, resolution: "mapped", itemId, ignoredReason: "", updatedAt: now }).where(eq(reportExternalProducts.id, id))
      : db.insert(reportExternalProducts).values({ id, sourceType: channel, externalKey: externalSku, externalVariantKey: "", externalName, resolution: "mapped", itemId, ignoredReason: "" }),
    ...(!useBundle ? [db.delete(itemMasters).where(eq(itemMasters.id, targetBundleItemId(id)))] : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping", entityId: id, entityLabel: externalName,
      eventType: existing ? "product_sku_mapping_updated" : "product_sku_mapping_created",
      summary: `${existing ? "更新" : "新增"}${channel} 外部 SKU 對應：${externalSku}（${components.length} 個組合用料）`,
      field: "externalSku", newValue: externalSku, actor: input.actor, source: "wms",
    })),
  ] as never);
  return { id, channel, externalName, externalSku };
}

export async function addProductSkuMapping(
  db: Database,
  input: { channel?: string; externalName: string; externalSku: string; components: ProductBundleComponentInput[]; actor: Actor },
): Promise<{ id: string; channel: string; externalName: string; externalSku: string }> {
  return addTargetProductSkuMapping(db, input);
}

async function updateTargetProductSkuMapping(
  db: Database,
  input: { id: string; channel?: string; externalName: string; externalSku: string; components: ProductBundleComponentInput[]; actor: Actor },
) {
  const [mapping] = await db.select().from(reportExternalProducts).where(eq(reportExternalProducts.id, input.id)).limit(1);
  if (!mapping || mapping.resolution !== "mapped") throw new WmsError("not_found", "找不到這筆外部 SKU 對應。");
  const channel = normalizeProductSkuChannel(input.channel ?? mapping.sourceType);
  const externalSku = normalizeExternalSku(input.externalSku);
  const externalName = input.externalName.trim();
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  if (!externalName) throw new WmsError("invalid", "通路商品名稱不可為空。");
  const components = validateBundleComponents(input.components);
  await requireExternalSkuAvailable(db, externalSku,
    components.map((component) => component.itemId ?? component.inventoryItemId).filter((id): id is string => !!id),
    components.map((component) => component.customSku).filter((sku): sku is string => !!sku));
  const [existing] = await db.select({ id: reportExternalProducts.id }).from(reportExternalProducts).where(and(
    eq(reportExternalProducts.sourceType, channel), eq(reportExternalProducts.externalKey, externalSku),
    eq(reportExternalProducts.externalVariantKey, ""), ne(reportExternalProducts.id, input.id),
  )).limit(1);
  if (existing) throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經對應到其他商品。`);

  const now = new Date().toISOString();
  const componentItemIds = await prepareTargetComponentItems(db, components);
  const useBundle = components.length !== 1 || components[0]!.quantity !== 1;
  const itemId = useBundle ? await ensureTargetBundleItem(db, input.id, externalName, now) : componentItemIds[0]!;
  const bundleRows = useBundle ? componentItemIds.map((componentItemId, index) => ({
    parentItemId: itemId,
    componentItemId,
    quantity: components[index]!.quantity,
    createdAt: now,
    updatedAt: now,
  })) : [];
  const oldBundle = mapping.itemId === targetBundleItemId(input.id);
  await db.batch([
    db.update(reportExternalProducts).set({ sourceType: channel, externalKey: externalSku, externalName, itemId, updatedAt: now }).where(eq(reportExternalProducts.id, input.id)),
    db.delete(itemComponents).where(eq(itemComponents.parentItemId, targetBundleItemId(input.id))),
    ...(bundleRows.length ? [db.insert(itemComponents).values(bundleRows)] : []),
    ...(!useBundle && oldBundle ? [db.delete(itemMasters).where(eq(itemMasters.id, targetBundleItemId(input.id)))] : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping", entityId: input.id, entityLabel: externalName,
      eventType: "product_sku_mapping_updated", summary: `更新${channel} 外部 SKU 對應：${externalSku}（${components.length} 個組合用料）`,
      field: "externalSku", oldValue: mapping.externalKey, newValue: externalSku, actor: input.actor, source: "wms",
    })),
  ] as never);
  return { id: input.id, channel, externalName, externalSku };
}

export async function updateProductSkuMapping(
  db: Database,
  input: { id: string; channel?: string; externalName: string; externalSku: string; components: ProductBundleComponentInput[]; actor: Actor },
): Promise<{ id: string; channel: string; externalName: string; externalSku: string }> {
  return updateTargetProductSkuMapping(db, input);
}

export async function deleteProductSkuMapping(db: Database, id: string, actor: Actor): Promise<void> {
  const [mapping] = await db.select().from(reportExternalProducts).where(eq(reportExternalProducts.id, id)).limit(1);
  if (!mapping || mapping.resolution !== "mapped") throw new WmsError("not_found", "找不到這筆外部 SKU 對應。");
  const bundleId = targetBundleItemId(id);
  const [bundle] = await db.select({ id: itemMasters.id }).from(itemMasters).where(eq(itemMasters.id, bundleId)).limit(1);
  await db.batch([
    db.delete(reportExternalProducts).where(eq(reportExternalProducts.id, id)),
    ...(bundle ? [db.delete(itemMasters).where(eq(itemMasters.id, bundleId))] : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping", entityId: id, entityLabel: mapping.externalName || mapping.externalKey,
      eventType: "product_sku_mapping_deleted", summary: `移除${mapping.sourceType} 外部 SKU 對應：${mapping.externalKey}`,
      field: "externalSku", oldValue: mapping.externalKey, actor, source: "wms",
    })),
  ] as never);
}

interface TargetItemRow {
  id: string;
  source: "cyberbiz" | "custom";
  sku: string;
  name: string;
  categoryId: string | null;
}

async function resolveTargetProductSkus(db: Database, externalSkus: string[], channel: string): Promise<Map<string, ResolvedProductSku>> {
  const normalizedChannel = normalizeProductSkuChannel(channel);
  const wanted = [...new Set(externalSkus.map(normalizeExternalSku).filter(Boolean))];
  if (!wanted.length) return new Map();
  const baseKeys = normalizedChannel === "shopee"
    ? wanted.map(shopeeBaseExternalSku).filter(Boolean)
    : [];
  const lookupWanted = [...new Set([...wanted, ...baseKeys])];
  const [externalRows, directRows, catalogRows, categories] = await Promise.all([
    db.select({
      sourceType: reportExternalProducts.sourceType,
      externalKey: reportExternalProducts.externalKey,
      externalName: reportExternalProducts.externalName,
      resolution: reportExternalProducts.resolution,
      itemId: reportExternalProducts.itemId,
    })
      .from(reportExternalProducts)
      .where(and(eq(reportExternalProducts.sourceType, normalizedChannel), inArray(reportExternalProducts.externalKey, lookupWanted))),
    db.select({ id: itemMasters.id, source: itemMasters.source, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId })
      .from(wmsItems)
      .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
      .where(sql`UPPER(${itemMasters.sku}) IN (${sql.join(lookupWanted.map((sku) => sql`${sku}`), sql`, `)})`),
    db.select({
      id: itemMasters.id, source: itemMasters.source, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId,
      productName: cyberbizProducts.productName, variantName: cyberbizProducts.variantName,
    })
      .from(cyberbizProducts)
      .innerJoin(itemMasters, eq(itemMasters.id, cyberbizProducts.itemId))
      .where(sql`UPPER(${itemMasters.sku}) IN (${sql.join(lookupWanted.map((sku) => sql`${sku}`), sql`, `)})`),
    categoryNames(db),
  ]);
  const categoryById = categories;
  const parentIds = [...new Set(externalRows.map((row) => row.itemId).filter((id): id is string => !!id))];
  const bundleRows = await inBatches(parentIds, (batch) => db
    .select({ parentItemId: itemComponents.parentItemId, componentItemId: itemComponents.componentItemId, quantity: itemComponents.quantity })
    .from(itemComponents)
    .where(inArray(itemComponents.parentItemId, batch))
    .orderBy(asc(itemComponents.parentItemId), sql`rowid`));
  const componentIds = [...new Set(bundleRows.map((row) => row.componentItemId))];
  const [componentItems, wmsComponentRows] = await Promise.all([
    inBatches(componentIds, (batch) => db.select({ id: itemMasters.id, source: itemMasters.source, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId }).from(itemMasters).where(inArray(itemMasters.id, batch))),
    inBatches(componentIds, (batch) => db.select({ itemId: wmsItems.itemId }).from(wmsItems).where(inArray(wmsItems.itemId, batch))),
  ]);
  const componentById = new Map(componentItems.map((row) => [row.id, row]));
  const wmsIds = new Set(wmsComponentRows.map((row) => row.itemId));
  const componentsByParent = new Map<string, typeof bundleRows>();
  for (const row of bundleRows) {
    const list = componentsByParent.get(row.parentItemId) ?? [];
    list.push(row);
    componentsByParent.set(row.parentItemId, list);
  }
  const targetComponent = (item: TargetItemRow, quantity: number): ResolvedProductSkuComponent => ({
    inventoryItemId: wmsIds.has(item.id) ? item.id : null,
    sku: item.sku,
    name: item.name,
    category: categoryById.get(item.categoryId ?? "") ?? "未分類",
    quantity,
  });
  const componentsFor = (parent: TargetItemRow): ResolvedProductSkuComponent[] => {
    const children = (componentsByParent.get(parent.id) ?? [])
      .map((row) => {
        const item = componentById.get(row.componentItemId);
        return item ? targetComponent(item, row.quantity) : null;
      })
      .filter((row): row is ResolvedProductSkuComponent => row !== null);
    return children.length ? children : [targetComponent(parent, 1)];
  };
  const directWms = new Map<string, TargetItemRow>();
  for (const row of directRows) {
    const key = normalizeExternalSku(row.sku);
    if (key) directWms.set(key, row);
  }
  const directCatalog = new Map<string, TargetItemRow>();
  for (const row of catalogRows) {
    const key = normalizeExternalSku(row.sku);
    if (key) directCatalog.set(key, row);
  }
  const ignored = new Set(externalRows.filter((row) => row.resolution === "ignored").map((row) => normalizeExternalSku(row.externalKey)));
  const mapped = new Map<string, { item: TargetItemRow; externalName: string }>();
  for (const row of externalRows) {
    if (row.resolution !== "mapped" || !row.itemId) continue;
    const item = [...directRows, ...catalogRows].find((candidate) => candidate.id === row.itemId);
    // bundle parent 不一定在 WMS 或 CYBERBIZ 目錄，另外查 item master。
    if (item) mapped.set(normalizeExternalSku(row.externalKey), { item, externalName: row.externalName });
    else {
      const [parent] = await db.select({ id: itemMasters.id, source: itemMasters.source, sku: itemMasters.sku, name: itemMasters.name, categoryId: itemMasters.categoryId })
        .from(itemMasters).where(eq(itemMasters.id, row.itemId)).limit(1);
      if (parent) mapped.set(normalizeExternalSku(row.externalKey), { item: parent, externalName: row.externalName });
    }
  }
  const resolved = new Map<string, ResolvedProductSku>();
  for (const key of wanted) {
    if (ignored.has(key)) continue;
    const direct = directWms.get(key);
    // WMS SKU 本身優先於外部 mapping；但 CYBERBIZ 目錄只是報表商品的
    // fallback，若有人明確建立 mapping，仍應依 mapping 的 target item 解析。
    if (direct) {
      resolved.set(key, { externalName: direct.name, components: [targetComponent(direct, 1)] });
      continue;
    }
    const explicit = mapped.get(key);
    if (explicit) {
      resolved.set(key, { externalName: explicit.externalName || explicit.item.name, components: componentsFor(explicit.item) });
      continue;
    }
    const catalog = directCatalog.get(key);
    if (catalog) resolved.set(key, { externalName: catalog.name, components: [targetComponent(catalog, 1)] });
  }
  if (normalizedChannel === "shopee") {
    for (const key of wanted) {
      if (resolved.has(key) || ignored.has(key)) continue;
      const base = shopeeBaseExternalSku(key);
      if (base && resolved.has(base)) resolved.set(key, resolved.get(base)!);
    }
  }
  return resolved;
}

export async function resolveProductSkus(db: Database, externalSkus: string[], channel = "legacy"): Promise<Map<string, ResolvedProductSku>> {
  return resolveTargetProductSkus(db, externalSkus, normalizeProductSkuChannel(channel));
}

export interface ReportSkuIgnoreRow {
  id: string;
  channel: string;
  externalSku: string;
  reason: string;
  createdAt: string;
}

export async function listReportSkuIgnores(db: Database): Promise<ReportSkuIgnoreRow[]> {
  return db.select({
    id: reportExternalProducts.id,
    channel: reportExternalProducts.sourceType,
    externalSku: reportExternalProducts.externalKey,
    reason: reportExternalProducts.ignoredReason,
    createdAt: reportExternalProducts.createdAt,
  })
    .from(reportExternalProducts)
    .where(eq(reportExternalProducts.resolution, "ignored"))
    .orderBy(asc(reportExternalProducts.sourceType), asc(reportExternalProducts.externalKey));
}

export async function addReportSkuIgnore(
  db: Database,
  input: { channel: string; externalSku: string; reason?: string; actor: Actor },
): Promise<ReportSkuIgnoreRow> {
  const channel = normalizeProductSkuChannel(input.channel);
  const externalSku = normalizeExternalSku(input.externalSku);
  const reason = (input.reason ?? "").trim();
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  const [existing] = await db.select().from(reportExternalProducts).where(and(
    eq(reportExternalProducts.sourceType, channel), eq(reportExternalProducts.externalKey, externalSku), eq(reportExternalProducts.externalVariantKey, ""),
  )).limit(1);
  if (existing?.resolution === "ignored") throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經標記為不納入報表。`);
  const id = existing?.id ?? crypto.randomUUID();
  await db.batch([
    existing
      ? db.update(reportExternalProducts).set({ resolution: "ignored", itemId: null, ignoredReason: reason, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(reportExternalProducts.id, id))
      : db.insert(reportExternalProducts).values({ id, sourceType: channel, externalKey: externalSku, externalVariantKey: "", externalName: "", resolution: "ignored", itemId: null, ignoredReason: reason }),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping", entityId: id, entityLabel: `${channel} · ${externalSku}`,
      eventType: "product_sku_mapping_updated", summary: `標記${channel} 外部 SKU「${externalSku}」不納入報表${reason ? `：${reason}` : ""}`,
      field: "externalSku", newValue: externalSku, actor: input.actor, source: "wms",
    })),
  ] as never);
  const [created] = await db.select({ createdAt: reportExternalProducts.createdAt }).from(reportExternalProducts).where(eq(reportExternalProducts.id, id));
  return { id, channel, externalSku, reason, createdAt: created?.createdAt ?? "" };
}

export async function deleteReportSkuIgnore(db: Database, id: string, actor: Actor): Promise<void> {
  const [row] = await db.select({ sourceType: reportExternalProducts.sourceType, externalKey: reportExternalProducts.externalKey, resolution: reportExternalProducts.resolution })
    .from(reportExternalProducts).where(eq(reportExternalProducts.id, id));
  if (!row) throw new WmsError("not_found", "找不到這筆忽略設定。");
  if (row.resolution !== "ignored") throw new WmsError("conflict", "這筆外部商品目前不是忽略狀態。");
  await db.batch([
    db.delete(reportExternalProducts).where(eq(reportExternalProducts.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping", entityId: id, entityLabel: `${row.sourceType} · ${row.externalKey}`,
      eventType: "product_sku_mapping_updated", summary: `取消忽略${row.sourceType} 外部 SKU「${row.externalKey}」`,
      field: "externalSku", oldValue: row.externalKey, actor, source: "wms",
    })),
  ] as never);
}

export async function resolveIgnoredSkus(db: Database, externalSkus: string[], channel = "legacy"): Promise<Set<string>> {
  const normalized = [...new Set(externalSkus.map(normalizeExternalSku).filter(Boolean))];
  if (!normalized.length) return new Set();
  const normalizedChannel = normalizeProductSkuChannel(channel);
  const basePairs = normalizedChannel === "shopee"
    ? normalized.map((sku) => [sku, shopeeBaseExternalSku(sku)] as const).filter(([, base]) => base)
    : [];
  const wanted = [...new Set([...normalized, ...basePairs.map(([, base]) => base)])];
  const rows = await db.select({ externalKey: reportExternalProducts.externalKey })
    .from(reportExternalProducts)
    .where(and(
      eq(reportExternalProducts.sourceType, normalizedChannel),
      eq(reportExternalProducts.resolution, "ignored"),
      inArray(reportExternalProducts.externalKey, wanted),
    ));
  const ignored = new Set(rows.map((row) => normalizeExternalSku(row.externalKey)));
  for (const [sku, base] of basePairs) if (ignored.has(base)) ignored.add(sku);
  return ignored;
}

/** 把官網目錄寫進 target items 與 cyberbiz_products；不建立 wms_items。 */
export async function syncCyberbizProducts(
  db: Database,
  products: ReadonlyArray<{
    sku: string;
    productId: string;
    variantId: string;
    productName: string;
    variantName?: string;
    published?: boolean;
  }>,
): Promise<{ synced: number }> {
  const rows = new Map<string, { sku: string; productId: string; variantId: string; productName: string; variantName: string; published: number }>();
  for (const product of products) {
    const sku = normalizeExternalSku(product.sku ?? "");
    if (!sku) continue;
    rows.set(sku, {
      sku,
      productId: String(product.productId ?? ""),
      variantId: String(product.variantId ?? ""),
      productName: (product.productName ?? "").trim(),
      variantName: (product.variantName ?? "").trim(),
      published: product.published === false ? 0 : 1,
    });
  }
  for (const row of rows.values()) {
    const itemName = [row.productName, row.variantName].filter(Boolean).join(" - ") || row.sku;
    // SKU 是全平台唯一的，所以這裡不能只找 cyberbiz 那一筆：官網開始賣一個原本手動建的
    // SKU 時，要接管既有的品項，再插一筆新的會撞 idx_items_sku。名稱沿用既有的，
    // 官網回傳的 "商品 - 規格 -" 那種格式比人取的名字難讀。
    const [existing] = await db.select({ id: itemMasters.id, name: itemMasters.name })
      .from(itemMasters)
      .where(eq(itemMasters.sku, row.sku))
      .limit(1);
    const itemId = existing?.id ?? crypto.randomUUID();
    await db.insert(itemMasters).values({ id: itemId, source: "cyberbiz", kind: "sellable", sku: row.sku, name: existing?.name ?? itemName, active: 1 })
      .onConflictDoUpdate({ target: itemMasters.sku, set: { source: "cyberbiz", active: 1, updatedAt: sql`CURRENT_TIMESTAMP` } });
    await db.insert(cyberbizProducts).values({
      itemId,
      cyberbizProductId: row.productId,
      cyberbizVariantId: row.variantId,
      productName: row.productName,
      variantName: row.variantName,
      published: row.published,
      rawJson: "{}",
      syncStatus: "synced",
      syncedAt: sql`CURRENT_TIMESTAMP`,
    }).onConflictDoUpdate({
      target: cyberbizProducts.itemId,
      set: {
        cyberbizProductId: row.productId,
        cyberbizVariantId: row.variantId,
        productName: row.productName,
        variantName: row.variantName,
        published: row.published,
        syncStatus: "synced",
        syncedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
  }
  return { synced: rows.size };
}

export interface CyberbizProductOption {
  sku: string;
  name: string;
  published: boolean;
}

export interface CyberbizReportProductOption extends CyberbizProductOption {
  aliases: string[];
}

export async function listCyberbizProducts(db: Database): Promise<CyberbizProductOption[]> {
  const rows = await db.select({
    sku: itemMasters.sku,
    productName: cyberbizProducts.productName,
    variantName: cyberbizProducts.variantName,
    published: cyberbizProducts.published,
  })
    .from(cyberbizProducts)
    .innerJoin(itemMasters, eq(itemMasters.id, cyberbizProducts.itemId))
    .orderBy(asc(cyberbizProducts.productName), asc(itemMasters.sku));
  return rows.map((row) => ({ sku: row.sku, name: formatCyberbizProductName(row), published: row.published === 1 }));
}

export async function listCyberbizReportProducts(db: Database): Promise<CyberbizReportProductOption[]> {
  const catalog = await listCyberbizProducts(db);
  const mappings = await db.select({ sku: reportExternalProducts.externalKey, name: reportExternalProducts.externalName })
    .from(reportExternalProducts)
    .where(and(
      eq(reportExternalProducts.sourceType, "cyberbiz"),
      eq(reportExternalProducts.resolution, "mapped"),
    ));
  const products = new Map<string, CyberbizReportProductOption>(catalog.map((product) => [
    normalizeExternalSku(product.sku), { ...product, sku: normalizeExternalSku(product.sku), aliases: [] },
  ]));
  for (const mapping of mappings) {
    const sku = normalizeExternalSku(mapping.sku);
    const name = mapping.name.trim();
    if (!sku || !name) continue;
    const product = products.get(sku);
    if (product) {
      if (product.name !== name && !product.aliases.includes(name)) product.aliases.push(name);
    } else {
      products.set(sku, { sku, name, published: false, aliases: [] });
    }
  }
  return [...products.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-TW") || left.sku.localeCompare(right.sku, "en"));
}
