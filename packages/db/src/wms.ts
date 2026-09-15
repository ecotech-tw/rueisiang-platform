import { and, asc, count, eq, notInArray, sql } from "drizzle-orm";
import { activityRow, type ActivityEntityType } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { cyberbizProducts, itemComponents, items as itemMasters } from "./schema/items.js";
import { reportExternalProducts } from "./schema/reports.js";
import { mediaObjects } from "./schema/media.js";
import {
  wmsCategories,
  wmsItems,
  wmsLayouts,
  wmsLayoutElements,
  wmsShelves,
  wmsZoneImages,
  wmsZones,
} from "./schema/wms.js";

export interface Actor { id: string; email: string }
const SETTINGS_ID = "main";
const DECORATION_ID_PREFIX = "wms-decoration:";
const LEGACY_DECORATION_ID_PREFIX = "wms-decoration-";
export interface ShelfLevel { id: string; name: string }
const DEFAULT_SHELF_LEVELS: ShelfLevel[] = [
  { id: "top", name: "上層" }, { id: "middle", name: "中層" }, { id: "bottom", name: "底層" },
];

export interface WarehouseSnapshot {
  settings: { canvasWidth: number; canvasHeight: number };
  zones: Array<Record<string, any>>;
  layoutElements: Array<Record<string, any>>;
  categories: Array<Record<string, any>>;
  items: Array<Record<string, any>>;
}

const BOUNDS = {
  x: { min: 0, max: 92 }, y: { min: 0, max: 92 }, width: { min: 8, max: 42 }, height: { min: 8, max: 38 },
} as const;
/** 地圖標示是輔助文字，允許比倉位小；前端 useDragBox 也使用同一組最小值。 */
const ELEMENT_BOUNDS = {
  x: { min: 0, max: 92 }, y: { min: 0, max: 92 }, width: { min: 2, max: 42 }, height: { min: 2, max: 38 },
} as const;
const CANVAS = { width: { min: 900, max: 3200, fallback: 1600 }, height: { min: 550, max: 2000, fallback: 900 } } as const;
const QUANTITY = { min: 0, max: 1_000_000 } as const;

function clamp(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(parsed)));
}

export function normalizeShelfLevels(value: unknown, fallback = DEFAULT_SHELF_LEVELS): ShelfLevel[] {
  if (!Array.isArray(value) || !value.length) return fallback;
  const used = new Set<string>();
  return value.slice(0, 12).map((raw, index) => {
    const level = (raw ?? {}) as Record<string, unknown>;
    const base = String(level.id ?? "").trim().replace(/[^a-zA-Z0-9-]/g, "-") || `level-${index + 1}`;
    let id = base;
    while (used.has(id)) id = `${base}-${index + 1}`;
    used.add(id);
    return { id, name: String(level.name ?? "").trim().slice(0, 20) || `第 ${index + 1} 層` };
  });
}

export function parseShelfLevels(value: string | null | undefined): ShelfLevel[] {
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed) && parsed.length) return parsed as ShelfLevel[];
  } catch {
    // 損壞的舊資料回到預設層，避免整個地圖無法開啟。
  }
  return DEFAULT_SHELF_LEVELS;
}

export class WmsError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "WmsError";
  }
}

function writeEvent(db: Database, input: {
  entityType: ActivityEntityType; entityId: string; entityLabel: string; eventType: string; summary: string;
  field?: string; oldValue?: string | null; newValue?: string | null; payload?: unknown; actor: Actor;
}) {
  return db.insert(activityEvents).values(activityRow({ ...input, source: "wms" }));
}
function asPosition(box: { x: number; y: number }): string { return `${box.x}%, ${box.y}%`; }
function asSize(box: { width: number; height: number }): string { return `${box.width}% × ${box.height}%`; }

/** 儲存層的裝飾 id 帶種類前綴；API 對外沿用新增時回傳的原始 id。 */
function publicDecorationId(id: string): string {
  if (id.startsWith(DECORATION_ID_PREFIX)) return id.slice(DECORATION_ID_PREFIX.length);
  if (id.startsWith(LEGACY_DECORATION_ID_PREFIX)) return id.slice(LEGACY_DECORATION_ID_PREFIX.length);
  return id;
}

function decorationStorageId(id: string): string {
  return `${DECORATION_ID_PREFIX}${publicDecorationId(id)}`;
}

/**
 * 找裝飾時保留舊資料格式：開發 fixture 曾直接用公開 id，早期資料也可能用連字號前綴。
 * 新資料一律使用冒號前綴，但讀寫不能因為資料尚未回填就把標籤判成不存在。
 */
async function findDecoration(db: Database, id: string) {
  const publicId = publicDecorationId(id);
  const storageIds = [
    decorationStorageId(publicId),
    publicId,
    `${LEGACY_DECORATION_ID_PREFIX}${publicId}`,
  ];
  for (const storageId of storageIds) {
    const [element] = await db.select().from(wmsLayoutElements)
      .where(and(eq(wmsLayoutElements.id, storageId), eq(wmsLayoutElements.elementType, "decoration")))
      .limit(1);
    if (element) return element;
  }
  return null;
}

async function loadTargetWarehouse(db: Database): Promise<WarehouseSnapshot> {
  const [layout] = await db.select().from(wmsLayouts).where(eq(wmsLayouts.active, 1)).orderBy(asc(wmsLayouts.id)).limit(1);
  const [zoneRows, elementRows, categoryRows, itemRows, shelfRows, imageRows, cyberbizRows] = await Promise.all([
    db.select().from(wmsZones).orderBy(asc(wmsZones.code)),
    db.select().from(wmsLayoutElements).orderBy(asc(wmsLayoutElements.zIndex), asc(wmsLayoutElements.label)),
    db.select().from(wmsCategories).orderBy(asc(wmsCategories.name)),
    db.select({ wms: wmsItems, item: itemMasters }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).orderBy(asc(itemMasters.name)),
    db.select().from(wmsShelves).orderBy(asc(wmsShelves.zoneId), asc(wmsShelves.sortOrder)),
    db.select({ zoneId: wmsZoneImages.zoneId, total: count() }).from(wmsZoneImages).groupBy(wmsZoneImages.zoneId),
    db.select().from(cyberbizProducts),
  ]);
  const cyberbizByItem = new Map(cyberbizRows.map((product) => [product.itemId, product]));
  const shelvesByZone = new Map<string, ShelfLevel[]>();
  for (const shelf of shelfRows) shelvesByZone.set(shelf.zoneId, [...(shelvesByZone.get(shelf.zoneId) ?? []), { id: shelf.code, name: shelf.name }]);
  const imageCounts = new Map(imageRows.map((row) => [row.zoneId, row.total]));
  const shelfById = new Map(shelfRows.map((shelf) => [shelf.id, shelf]));
  return {
    settings: { canvasWidth: layout?.canvasWidth ?? CANVAS.width.fallback, canvasHeight: layout?.canvasHeight ?? CANVAS.height.fallback },
    zones: zoneRows.map((zone) => {
      const element = elementRows.find((candidate) => candidate.zoneId === zone.id);
      return { ...zone, category: "", x: element?.x ?? 0, y: element?.y ?? 0, width: element?.width ?? 18, height: element?.height ?? 16, shelfLevels: shelvesByZone.get(zone.id) ?? DEFAULT_SHELF_LEVELS, imageCount: imageCounts.get(zone.id) ?? 0 };
    }),
    // zone 也是一種 layout element，但地圖會依 zones 另外渲染；只回傳裝飾，避免同一個倉位畫兩次。
    // 儲存層 id 帶 wms-decoration: 前綴，不能把那個內部 id 直接交給更新 API。
    layoutElements: elementRows
      .filter((element) => element.elementType === "decoration")
      .map((element) => ({ ...element, id: publicDecorationId(element.id) })),
    categories: categoryRows,
    items: itemRows.map(({ wms, item }) => {
      const shelf = wms.shelfId ? shelfById.get(wms.shelfId) : undefined;
      const category = wms.wmsCategoryId ? categoryRows.find((candidate) => candidate.id === wms.wmsCategoryId) : undefined;
      const product = cyberbizByItem.get(item.id);
      return {
        id: item.id, source: item.source, sku: item.sku, name: item.name, category: category?.name ?? "未分類", quantity: wms.quantity,
        unit: wms.unit, minStock: wms.minStock, zoneId: shelf?.zoneId ?? null, shelfLevel: shelf?.code ?? null,
        notes: wms.notes, updatedAt: wms.updatedAt,
        cyberbiz: product ? { cyberbizProductId: product.cyberbizProductId, cyberbizVariantId: product.cyberbizVariantId, sku: item.sku, syncStatus: product.syncStatus, syncedAt: product.syncedAt } : null,
      };
    }),
  };
}

export async function loadWarehouse(db: Database): Promise<WarehouseSnapshot> { return loadTargetWarehouse(db); }

export interface ZoneInput {
  code: string; name: string; category?: string; color?: string; x?: unknown; y?: unknown; width?: unknown; height?: unknown; shelfLevels?: unknown; notes?: string;
}

export async function createZone(db: Database, input: ZoneInput & { actor: Actor }) {
  const id = crypto.randomUUID();
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const shelves = normalizeShelfLevels(input.shelfLevels);
  const zone = { id, code, name, color: input.color?.trim() || "mint", notes: input.notes?.trim() || "", x: clamp(input.x, 38, BOUNDS.x), y: clamp(input.y, 38, BOUNDS.y), width: clamp(input.width, 18, BOUNDS.width), height: clamp(input.height, 16, BOUNDS.height), shelfLevels: JSON.stringify(shelves) };
  await db.batch([
    db.insert(wmsLayouts).values({ id: "layout:main", name: "主倉庫", canvasWidth: CANVAS.width.fallback, canvasHeight: CANVAS.height.fallback, active: 1 }).onConflictDoNothing(),
    db.insert(wmsZones).values({ id, code, name, color: zone.color, notes: zone.notes, active: 1 }),
    db.insert(wmsLayoutElements).values({ id: `wms-zone:${id}`, layoutId: "layout:main", elementType: "zone", zoneId: id, label: name, color: zone.color, x: zone.x, y: zone.y, width: zone.width, height: zone.height, zIndex: 0 }),
    ...shelves.map((shelf, index) => db.insert(wmsShelves).values({ id: crypto.randomUUID(), zoneId: id, code: shelf.id, name: shelf.name, sortOrder: index, active: 1 })),
    writeEvent(db, { entityType: "wms_zone", entityId: id, entityLabel: `${code} ${name}`, eventType: "zone_created", summary: "新增倉位", payload: zone, actor: input.actor }),
  ] as never);
  return { id };
}

export async function updateZone(db: Database, id: string, input: Partial<ZoneInput> & { actor: Actor }) {
  const [currentZone] = await db.select().from(wmsZones).where(eq(wmsZones.id, id)).limit(1);
  const [currentElement] = await db.select().from(wmsLayoutElements).where(and(eq(wmsLayoutElements.zoneId, id), eq(wmsLayoutElements.elementType, "zone"))).limit(1);
  const currentShelves = await db.select().from(wmsShelves).where(eq(wmsShelves.zoneId, id)).orderBy(asc(wmsShelves.sortOrder));
  if (!currentZone || !currentElement) throw new WmsError("not_found", "找不到這個倉位。");
  const current = { ...currentZone, category: "", x: currentElement.x, y: currentElement.y, width: currentElement.width, height: currentElement.height, shelfLevels: JSON.stringify(currentShelves.map((shelf) => ({ id: shelf.code, name: shelf.name }))) };
  const shelves = input.shelfLevels === undefined ? currentShelves.map((shelf) => ({ id: shelf.code, name: shelf.name })) : normalizeShelfLevels(input.shelfLevels, parseShelfLevels(current.shelfLevels));
  if (input.shelfLevels !== undefined) {
    const allowed = new Set(shelves.map((shelf) => shelf.id));
    const inUse = await db.select({ shelfLevel: wmsShelves.code }).from(wmsItems).innerJoin(wmsShelves, eq(wmsShelves.id, wmsItems.shelfId)).where(eq(wmsShelves.zoneId, id));
    if (inUse.some((row) => row.shelfLevel !== null && !allowed.has(row.shelfLevel))) throw new WmsError("conflict", "還有商品放在要移除的層架上，請先把商品移到別層。");
  }
  const next = { code: (input.code?.trim() || current.code).toUpperCase(), name: input.name?.trim() || current.name, color: input.color?.trim() || current.color, x: clamp(input.x, current.x, BOUNDS.x), y: clamp(input.y, current.y, BOUNDS.y), width: clamp(input.width, current.width, BOUNDS.width), height: clamp(input.height, current.height, BOUNDS.height), notes: input.notes === undefined ? current.notes : input.notes.trim() };
  const moved = input.x !== undefined || input.y !== undefined;
  const resized = input.width !== undefined || input.height !== undefined;
  await db.batch([
    db.update(wmsZones).set({ code: next.code, name: next.name, color: next.color, notes: next.notes, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsZones.id, id)),
    db.update(wmsLayoutElements).set({ label: next.name, color: next.color, x: next.x, y: next.y, width: next.width, height: next.height, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsLayoutElements.id, currentElement.id)),
    db.delete(wmsShelves).where(and(eq(wmsShelves.zoneId, id), shelves.length ? notInArray(wmsShelves.code, shelves.map((shelf) => shelf.id)) : sql`1 = 1`)),
    ...shelves.map((shelf, index) => db.insert(wmsShelves).values({ id: crypto.randomUUID(), zoneId: id, code: shelf.id, name: shelf.name, sortOrder: index, active: 1 }).onConflictDoUpdate({ target: [wmsShelves.zoneId, wmsShelves.code], set: { name: shelf.name, sortOrder: index, updatedAt: sql`CURRENT_TIMESTAMP` } })),
    writeEvent(db, { entityType: "wms_zone", entityId: id, entityLabel: `${next.code} ${next.name}`, eventType: moved ? "zone_moved" : resized ? "zone_resized" : "zone_updated", summary: moved ? "移動倉位" : resized ? "調整倉位大小" : "修改倉位資料", field: moved ? "position" : resized ? "size" : "details", oldValue: moved ? asPosition(current) : resized ? asSize(current) : null, newValue: moved ? asPosition(next) : resized ? asSize(next) : null, payload: { before: current, after: next }, actor: input.actor }),
  ] as never);
}

export async function deleteZone(db: Database, id: string, actor: Actor) {
  const [zone] = await db.select().from(wmsZones).where(eq(wmsZones.id, id)).limit(1);
  if (!zone) throw new WmsError("not_found", "找不到這個倉位。");
  const [usage] = await db.select({ total: count() }).from(wmsItems).innerJoin(wmsShelves, eq(wmsShelves.id, wmsItems.shelfId)).where(eq(wmsShelves.zoneId, id));
  if (Number(usage?.total ?? 0) > 0) throw new WmsError("conflict", `這個倉位還有 ${Number(usage?.total)} 項商品，請先移到別的倉位。`);
  await db.batch([
    db.delete(wmsLayoutElements).where(eq(wmsLayoutElements.zoneId, id)),
    db.delete(wmsShelves).where(eq(wmsShelves.zoneId, id)),
    db.delete(wmsZones).where(eq(wmsZones.id, id)),
    writeEvent(db, { entityType: "wms_zone", entityId: id, entityLabel: `${zone.code} ${zone.name}`, eventType: "zone_deleted", summary: "刪除倉位", payload: zone, actor }),
  ] as never);
}

export interface ItemInput { sku?: string; name: string; category: string; quantity?: unknown; unit?: string; minStock?: unknown; zoneId?: string | null; shelfLevel?: string | null; notes?: string }

async function requireCategory(db: Database, name: string): Promise<string> {
  const [category] = await db.select({ id: wmsCategories.id }).from(wmsCategories).where(eq(wmsCategories.name, name)).limit(1);
  if (!category) throw new WmsError("invalid", "請選一個已經建立的倉儲分類。");
  return category.id;
}

async function resolveTargetShelf(db: Database, zoneId: string | null, shelfCode: string | null): Promise<string | null> {
  if (!zoneId || !shelfCode) return null;
  const [shelf] = await db.select({ id: wmsShelves.id }).from(wmsShelves).where(and(eq(wmsShelves.zoneId, zoneId), eq(wmsShelves.code, shelfCode))).limit(1);
  if (!shelf) throw new WmsError("invalid", "找不到指定的層架。");
  return shelf.id;
}

async function requirePlacement(db: Database, zoneId: string | null, shelfLevel: string | null) {
  if (!zoneId) return { zoneId: null, shelfLevel: null, shelfId: null };
  const [zone] = await db.select({ id: wmsZones.id }).from(wmsZones).where(eq(wmsZones.id, zoneId)).limit(1);
  if (!zone) throw new WmsError("invalid", "找不到指定的倉位。");
  if (!shelfLevel) return { zoneId, shelfLevel: null, shelfId: null };
  const shelfId = await resolveTargetShelf(db, zoneId, shelfLevel);
  return { zoneId, shelfLevel, shelfId };
}

async function requireSkuAvailableForExternalMappings(db: Database, sku: string | null, itemId?: string) {
  if (!sku) return;
  const [mapping] = await db.select({ channel: reportExternalProducts.sourceType, externalSku: reportExternalProducts.externalKey })
    .from(reportExternalProducts)
    .where(and(eq(reportExternalProducts.externalKey, sku), eq(reportExternalProducts.resolution, "mapped"), itemId ? sql`NOT (${reportExternalProducts.itemId} = ${itemId})` : sql`1 = 1`)).limit(1);
  if (mapping) throw new WmsError("conflict", `WMS SKU「${sku}」已被外部 SKU 對應「${mapping.channel} · ${mapping.externalSku}」使用。`);
  // SKU 是全平台唯一（items 的 idx_items_sku），所以這裡不能只查 custom：打一個既有的
  // CYBERBIZ SKU 一樣是重複，只是會撞在索引上變成看不懂的錯誤訊息。
  const [owner] = await db.select({ name: itemMasters.name, source: itemMasters.source }).from(itemMasters)
    .where(and(eq(itemMasters.sku, sku), itemId ? sql`${itemMasters.id} <> ${itemId}` : undefined)).limit(1);
  if (owner) {
    throw new WmsError("conflict", owner.source === "cyberbiz"
      ? `SKU「${sku}」已經是 CYBERBIZ 品項「${owner.name}」，請從品項列表選取，不要另外建一筆。`
      : `SKU「${sku}」已被自訂品項「${owner.name}」使用，請改用別的 SKU。`);
  }
}

export async function updateItem(db: Database, id: string, input: Partial<ItemInput> & { actor: Actor }) {
  const [current] = await db.select({ item: itemMasters, wms: wmsItems, category: wmsCategories.name, shelf: wmsShelves })
    .from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).leftJoin(wmsCategories, eq(wmsCategories.id, wmsItems.wmsCategoryId)).leftJoin(wmsShelves, eq(wmsShelves.id, wmsItems.shelfId)).where(eq(wmsItems.itemId, id)).limit(1);
  if (!current) throw new WmsError("not_found", "找不到這項商品。");
  const [cyberbizProduct] = await db.select({ itemId: cyberbizProducts.itemId })
    .from(cyberbizProducts)
    .where(eq(cyberbizProducts.itemId, id))
    .limit(1);
  const category = input.category?.trim() || current.category || "";
  const wmsCategoryId = await requireCategory(db, category);
  const zoneId = input.zoneId === undefined ? current.shelf?.zoneId ?? null : input.zoneId?.trim() || null;
  const shelfLevel = input.shelfLevel === undefined ? current.shelf?.code ?? null : input.shelfLevel?.trim() || null;
  const placement = await requirePlacement(db, zoneId, shelfLevel);
  const nextName = input.name?.trim() || current.item.name;
  const nextSku = input.sku === undefined ? current.item.sku : input.sku.trim().toUpperCase() || current.item.sku;
  if (nextSku !== current.item.sku) {
    if (current.item.source !== "custom" || cyberbizProduct) throw new WmsError("conflict", "這項品項已連結 CYBERBIZ，SKU 必須與官網連結一致，不能在 WMS 修改。");
    await requireSkuAvailableForExternalMappings(db, nextSku, id);
  }
  const nextMinStock = clamp(input.minStock, current.wms.minStock, QUANTITY);
  if (nextMinStock !== current.wms.minStock) {
    if (current.item.source !== "custom" || cyberbizProduct) throw new WmsError("conflict", "這項商品已連結 CYBERBIZ，安全庫存以官網為準，請到官網修改。");
  }
  const next = { sku: nextSku, name: nextName, category, unit: input.unit?.trim() || current.wms.unit, minStock: nextMinStock, zoneId, shelfLevel, notes: input.notes === undefined ? current.wms.notes : input.notes.trim() };
  const moved = next.zoneId !== (current.shelf?.zoneId ?? null) || next.shelfLevel !== (current.shelf?.code ?? null);
  await db.batch([
    db.update(itemMasters).set({ name: next.name, sku: next.sku, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(itemMasters.id, id)),
    db.update(wmsItems).set({ wmsCategoryId, shelfId: placement.shelfId, unit: next.unit, minStock: next.minStock, notes: next.notes, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsItems.itemId, id)),
    writeEvent(db, { entityType: "item", entityId: id, entityLabel: `${next.sku} ${next.name}`, eventType: moved ? "item_moved" : "item_updated", summary: moved ? "調整商品存放位置" : "修改商品資料", field: moved ? "placement" : "details", payload: { before: current, after: next }, actor: input.actor }),
  ] as never);
}

export async function deleteItem(db: Database, id: string, actor: Actor) {
  const [current] = await db.select({ item: itemMasters, wms: wmsItems }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, id)).limit(1);
  if (!current) throw new WmsError("not_found", "找不到這項商品。");
  const [componentUse] = await db.select({ parentItemId: itemComponents.parentItemId }).from(itemComponents).where(eq(itemComponents.componentItemId, id)).limit(1);
  if (componentUse) throw new WmsError("conflict", "這項商品仍是 BOM 用料，請先移除組成後再移出倉儲。");
  await db.batch([
    db.delete(wmsItems).where(eq(wmsItems.itemId, id)),
    writeEvent(db, { entityType: "item", entityId: id, entityLabel: `${current.item.sku} ${current.item.name}`, eventType: "item_deleted", summary: "移出倉儲", payload: current.item, actor }),
  ] as never);
}

export async function countItem(db: Database, id: string, quantity: unknown, actor: Actor, note?: string) {
  const parsed = Number(quantity);
  if (!Number.isFinite(parsed) || parsed < 0) throw new WmsError("invalid", "盤點數量必須是 0 或正整數。");
  const [current] = await db.select({ item: itemMasters, wms: wmsItems }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, id)).limit(1);
  if (!current) throw new WmsError("not_found", "找不到這項商品。");
  const next = clamp(parsed, 0, QUANTITY);
  const changed = current.wms.quantity !== next;
  await db.batch([
    db.update(wmsItems).set({ quantity: next, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsItems.itemId, id)),
    writeEvent(db, { entityType: "item", entityId: id, entityLabel: `${current.item.sku} ${current.item.name}`, eventType: "item_counted", summary: note?.trim() || (changed ? "盤點更新庫存數量" : "盤點確認數量無誤"), field: "quantity", oldValue: String(current.wms.quantity), newValue: String(next), actor }),
  ] as never);
  return { quantity: next, changed, belowMinimum: next < current.wms.minStock };
}

export const WAREHOUSE_CATEGORY_COLORS = ["rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand"] as const;
function normalizeColor(value: unknown, fallback: string): string { const color = String(value ?? ""); return (WAREHOUSE_CATEGORY_COLORS as readonly string[]).includes(color) ? color : fallback; }

export async function createWarehouseCategory(db: Database, input: { name: string; color?: unknown; actor: Actor }) {
  const name = input.name.trim().slice(0, 40);
  if (!name) throw new WmsError("invalid", "請填寫倉儲分類名稱。");
  const category = { id: crypto.randomUUID(), name, color: normalizeColor(input.color, "rose") };
  await db.batch([
    db.insert(wmsCategories).values({ ...category, active: 1 }),
    writeEvent(db, { entityType: "wms_category", entityId: category.id, entityLabel: name, eventType: "warehouse_category_created", summary: "新增倉儲分類", payload: category, actor: input.actor }),
  ] as never);
  return { id: category.id };
}

export async function updateWarehouseCategory(db: Database, id: string, input: { name?: string; color?: unknown; actor: Actor }) {
  const [current] = await db.select().from(wmsCategories).where(eq(wmsCategories.id, id)).limit(1);
  if (!current) throw new WmsError("not_found", "找不到這個倉儲分類。");
  const next = { name: input.name?.trim().slice(0, 40) || current.name, color: normalizeColor(input.color, current.color) };
  await db.batch([
    db.update(wmsCategories).set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsCategories.id, id)),
    writeEvent(db, { entityType: "wms_category", entityId: id, entityLabel: next.name, eventType: "warehouse_category_updated", summary: next.name !== current.name ? "重新命名倉儲分類" : "修改倉儲分類顏色", field: next.name !== current.name ? "name" : "color", oldValue: next.name !== current.name ? current.name : current.color, newValue: next.name !== current.name ? next.name : next.color, payload: { before: current, after: next }, actor: input.actor }),
  ] as never);
}

export async function deleteWarehouseCategory(db: Database, id: string, actor: Actor) {
  const [category] = await db.select().from(wmsCategories).where(eq(wmsCategories.id, id)).limit(1);
  if (!category) throw new WmsError("not_found", "找不到這個倉儲分類。");
  const [usage] = await db.select({ total: count() }).from(wmsItems).where(eq(wmsItems.wmsCategoryId, id));
  if (Number(usage?.total ?? 0)) throw new WmsError("conflict", `還有 ${Number(usage?.total)} 項庫存商品是這個倉儲分類，請先改成別的分類。`);
  await db.batch([
    db.delete(wmsCategories).where(eq(wmsCategories.id, id)),
    writeEvent(db, { entityType: "wms_category", entityId: id, entityLabel: category.name, eventType: "warehouse_category_deleted", summary: "刪除倉儲分類", payload: category, actor }),
  ] as never);
}

export interface LayoutElementInput { label: string; color?: string; x?: unknown; y?: unknown; width?: unknown; height?: unknown }

export async function createLayoutElement(db: Database, input: LayoutElementInput & { actor: Actor }) {
  const id = crypto.randomUUID();
  const element = { id, label: input.label.trim().slice(0, 40), color: input.color?.trim() || "rose", x: clamp(input.x, 10, ELEMENT_BOUNDS.x), y: clamp(input.y, 10, ELEMENT_BOUNDS.y), width: clamp(input.width, 12, ELEMENT_BOUNDS.width), height: clamp(input.height, 10, ELEMENT_BOUNDS.height) };
  await db.batch([
    db.insert(wmsLayouts).values({ id: "layout:main", name: "主倉庫", canvasWidth: CANVAS.width.fallback, canvasHeight: CANVAS.height.fallback, active: 1 }).onConflictDoNothing(),
    db.insert(wmsLayoutElements).values({ id: `${DECORATION_ID_PREFIX}${id}`, layoutId: "layout:main", elementType: "decoration", label: element.label, color: element.color, x: element.x, y: element.y, width: element.width, height: element.height, zIndex: 1 }),
    writeEvent(db, { entityType: "layout_element", entityId: id, entityLabel: element.label, eventType: "element_created", summary: "新增地圖標示", payload: element, actor: input.actor }),
  ] as never);
  return { id };
}

export async function updateLayoutElement(db: Database, id: string, input: Partial<LayoutElementInput> & { actor: Actor }) {
  const publicId = publicDecorationId(id);
  const current = await findDecoration(db, id);
  if (!current) throw new WmsError("not_found", "找不到這個地圖標示。");
  const next = { label: input.label?.trim().slice(0, 40) || current.label, color: input.color?.trim() || current.color, x: clamp(input.x, current.x, ELEMENT_BOUNDS.x), y: clamp(input.y, current.y, ELEMENT_BOUNDS.y), width: clamp(input.width, current.width, ELEMENT_BOUNDS.width), height: clamp(input.height, current.height, ELEMENT_BOUNDS.height) };
  await db.batch([
    db.update(wmsLayoutElements).set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsLayoutElements.id, current.id)),
    writeEvent(db, { entityType: "layout_element", entityId: publicId, entityLabel: next.label, eventType: "element_updated", summary: "調整地圖標示", payload: { before: current, after: next }, actor: input.actor }),
  ] as never);
}

export async function deleteLayoutElement(db: Database, id: string, actor: Actor) {
  const publicId = publicDecorationId(id);
  const element = await findDecoration(db, id);
  if (!element) throw new WmsError("not_found", "找不到這個地圖標示。");
  await db.batch([
    db.delete(wmsLayoutElements).where(eq(wmsLayoutElements.id, element.id)),
    writeEvent(db, { entityType: "layout_element", entityId: publicId, entityLabel: element.label, eventType: "element_deleted", summary: "刪除地圖標示", payload: element, actor }),
  ] as never);
}

export async function updateWarehouseSettings(db: Database, input: { canvasWidth?: unknown; canvasHeight?: unknown; actor: Actor }) {
  const [current] = await db.select().from(wmsLayouts).where(eq(wmsLayouts.id, "layout:main")).limit(1);
  const next = { canvasWidth: clamp(input.canvasWidth, current?.canvasWidth ?? CANVAS.width.fallback, CANVAS.width), canvasHeight: clamp(input.canvasHeight, current?.canvasHeight ?? CANVAS.height.fallback, CANVAS.height) };
  await db.batch([
    db.insert(wmsLayouts).values({ id: "layout:main", name: "主倉庫", ...next, active: 1 }).onConflictDoUpdate({ target: wmsLayouts.id, set: { ...next, updatedAt: sql`CURRENT_TIMESTAMP` } }),
    writeEvent(db, { entityType: "warehouse", entityId: SETTINGS_ID, entityLabel: "倉庫地圖畫布", eventType: "canvas_resized", summary: `調整畫布為 ${next.canvasWidth} × ${next.canvasHeight}`, field: "canvas", oldValue: current ? `${current.canvasWidth} × ${current.canvasHeight}` : null, newValue: `${next.canvasWidth} × ${next.canvasHeight}`, actor: input.actor }),
  ] as never);
  return next;
}

function targetImageId(zoneId: string, objectKey: string): string {
  const bytes = new TextEncoder().encode(`${zoneId}\u0000${objectKey}`);
  return `target-${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function recordZoneImage(db: Database, input: { zoneId: string; objectKey: string; filename: string; contentType: string; size: number; actor: Actor }) {
  const [zone] = await db.select({ code: wmsZones.code, name: wmsZones.name }).from(wmsZones).where(eq(wmsZones.id, input.zoneId)).limit(1);
  if (!zone) throw new WmsError("not_found", "找不到這個倉位。");
  await db.batch([
    db.insert(wmsZoneImages).values({ zoneId: input.zoneId, objectKey: input.objectKey, sortOrder: 0 }).onConflictDoNothing(),
    writeEvent(db, { entityType: "wms_zone", entityId: input.zoneId, entityLabel: `${zone.code} ${zone.name}`, eventType: "image_uploaded", summary: "上傳倉位現場照片", field: "image", newValue: input.filename, actor: input.actor }),
  ] as never);
  return { id: targetImageId(input.zoneId, input.objectKey) };
}

const zoneImageSelect = {
  zoneId: wmsZoneImages.zoneId,
  imageObjectKey: wmsZoneImages.objectKey,
  sortOrder: wmsZoneImages.sortOrder,
  imageCreatedAt: wmsZoneImages.createdAt,
  filename: mediaObjects.filename,
  contentType: mediaObjects.contentType,
  size: mediaObjects.size,
};

export async function listZoneImages(db: Database, zoneId: string) {
  const rows = await db.select(zoneImageSelect).from(wmsZoneImages)
    .innerJoin(mediaObjects, eq(mediaObjects.objectKey, wmsZoneImages.objectKey))
    .where(eq(wmsZoneImages.zoneId, zoneId))
    .orderBy(asc(wmsZoneImages.sortOrder), asc(wmsZoneImages.createdAt));
  return rows.map((row) => ({
    id: targetImageId(row.zoneId, row.imageObjectKey), zoneId: row.zoneId, objectKey: row.imageObjectKey,
    filename: row.filename, contentType: row.contentType, size: row.size, createdAt: row.imageCreatedAt,
  }));
}

export async function findZoneImage(db: Database, id: string) {
  const rows = await db.select(zoneImageSelect).from(wmsZoneImages)
    .innerJoin(mediaObjects, eq(mediaObjects.objectKey, wmsZoneImages.objectKey));
  const row = rows.find((candidate) => targetImageId(candidate.zoneId, candidate.imageObjectKey) === id);
  return row ? {
    id, zoneId: row.zoneId, objectKey: row.imageObjectKey, filename: row.filename,
    contentType: row.contentType, size: row.size, createdAt: row.imageCreatedAt,
  } : null;
}

export async function deleteZoneImage(db: Database, id: string, actor: Actor) {
  const image = await findZoneImage(db, id);
  if (!image) throw new WmsError("not_found", "找不到這張照片。");
  const [zone] = await db.select({ code: wmsZones.code, name: wmsZones.name }).from(wmsZones).where(eq(wmsZones.id, image.zoneId)).limit(1);
  await db.batch([
    db.delete(wmsZoneImages).where(and(eq(wmsZoneImages.zoneId, image.zoneId), eq(wmsZoneImages.objectKey, image.objectKey))),
    writeEvent(db, { entityType: "wms_zone", entityId: image.zoneId, entityLabel: zone ? `${zone.code} ${zone.name}` : "", eventType: "image_deleted", summary: "刪除倉位現場照片", field: "image", oldValue: image.filename, actor }),
  ] as never);
  return { objectKey: image.objectKey };
}

export async function zoneImageKeys(db: Database, zoneId: string): Promise<string[]> {
  const rows = await db.select({ objectKey: wmsZoneImages.objectKey }).from(wmsZoneImages).where(eq(wmsZoneImages.zoneId, zoneId));
  return rows.map((row) => row.objectKey);
}
