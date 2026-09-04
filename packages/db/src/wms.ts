import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { activityRow, type ActivityEntityType } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { itemComponents, items as itemMasters } from "./schema/items.js";
import {
  customReportProducts,
  cyberbizProductLinks,
  inventoryItems,
  layoutElements,
  productBundleComponents,
  warehouseCategories,
  productSkuMappings,
  warehouseSettings,
  zoneImages,
  zones,
  wmsCategories,
  wmsItems,
  wmsLayouts,
  wmsLayoutElements,
  wmsShelves,
  wmsZoneImages,
  wmsZones,
} from "./schema/wms.js";

/**
 * 倉儲的查詢與寫入。
 *
 * 有一條規則跟 CRM 的 crm-write.ts **剛好相反**：那邊是「先寫官網、成功了才寫
 * 本地」，這裡是「先寫本地，官網同步失敗只把失敗記下來」。理由是兩邊的真相
 * 來源不同——客戶的真相在官網，所以官網沒有的人本地不該有；但庫存的真相是倉庫裡
 * 實際有幾件，人已經數完了，不能因為官網連不上就叫他重數一次。
 *
 * （官網同步本身下一階段才搬，這裡先把本地的部分做完。）
 */

export interface Actor {
  id: string;
  email: string;
}

/** 設定只會有一列，id 固定。 */
const SETTINGS_ID = "main";

/** 沒指定就給這三層。跟 schema 的 default 一致，要改就兩邊一起改。 */
const DEFAULT_SHELF_LEVELS: ShelfLevel[] = [
  { id: "top", name: "上層" },
  { id: "middle", name: "中層" },
  { id: "bottom", name: "底層" },
];

export interface ShelfLevel {
  id: string;
  name: string;
}

export interface WarehouseSnapshot {
  settings: { canvasWidth: number; canvasHeight: number };
  zones: Array<Record<string, any>>;
  layoutElements: Array<Record<string, any>>;
  categories: Array<Record<string, any>>;
  items: Array<Record<string, any>>;
}

/**
 * 座標與尺寸的合法範圍。**單位是百分比**，不是像素——畫的時候是
 * canvasWidth * x / 100，所以換畫布尺寸時整張圖會等比例縮放。
 */
const BOUNDS = {
  x: { min: 0, max: 92 },
  y: { min: 0, max: 92 },
  width: { min: 8, max: 42 },
  height: { min: 8, max: 38 },
} as const;

/** 畫布尺寸的上下限。太小放不下東西，太大瀏覽器畫不動。 */
const CANVAS = {
  width: { min: 900, max: 3200, fallback: 1600 },
  height: { min: 550, max: 2000, fallback: 900 },
} as const;

/** 數量欄位共用的範圍。上限只是防呆，避免有人貼上一串數字把畫面撐爆。 */
const QUANTITY = { min: 0, max: 1_000_000 } as const;

function clamp(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(parsed)));
}

/**
 * 把送進來的層架整理成可以存的樣子。
 *
 * id 會被存進 inventory_items.shelf_level，而那裡沒有外鍵擋著，所以要限制字元集：
 * 一個帶引號或空白的 id 會讓之後的比對莫名其妙對不起來。重複的 id 也要拆開，
 * 不然兩層會變成同一層。
 */
export function normalizeShelfLevels(value: unknown, fallback = DEFAULT_SHELF_LEVELS): ShelfLevel[] {
  if (!Array.isArray(value) || !value.length) return fallback;

  const used = new Set<string>();
  // 上限 12 層：再多下拉選單本身就不能用了，而且沒有倉位真的分那麼多層。
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
    // 存進去的一定是我們自己寫的 JSON，解不開代表資料壞了。退回預設值讓畫面還能
    // 用，總比整頁掛掉好。
  }
  return DEFAULT_SHELF_LEVELS;
}

/**
 * 回傳查詢本身（不是 Promise），才能跟資料的寫入放進同一個 db.batch。
 * 跟 crm-write.ts 的 writeEvent 同一個理由。
 */
function writeEvent(
  db: Database,
  input: {
    entityType: ActivityEntityType;
    entityId: string;
    entityLabel: string;
    eventType: string;
    summary: string;
    field?: string;
    /**
     * 欄位級的、**看得懂的**值——「48」「50」、「8%, 45%」。
     *
     * 整包物件的快照不要放這裡，放 payload。操作紀錄那一頁會把這兩個值直接印在
     * 「變更」欄，塞一整行 JSON 進去只會把版面撐爆而且沒有人讀得下去；
     * schema 上這兩欄本來就是給欄位級的變更用的。
     */
    oldValue?: string | null;
    newValue?: string | null;
    /** 完整快照。查得到，但不會被印在表格裡。 */
    payload?: unknown;
    actor: Actor;
  },
) {
  return db.insert(activityEvents).values(
    activityRow({
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      eventType: input.eventType,
      summary: input.summary,
      field: input.field,
      oldValue: input.oldValue,
      newValue: input.newValue,
      payload: input.payload,
      actor: input.actor,
      source: "wms",
    }),
  );
}

/** 位置與大小寫成看得懂的一小串，而不是一整包 JSON。 */
const asPosition = (box: { x: number; y: number }) => `${box.x}%, ${box.y}%`;
const asSize = (box: { width: number; height: number }) => `${box.width}% × ${box.height}%`;

/** 呼叫端要能分辨「找不到」跟「不給改」，兩者的 HTTP 狀態不一樣。 */
export class WmsError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "WmsError";
  }
}

// ───────────────────────────── 讀取 ─────────────────────────────

/**
 * 整個倉庫的現況，一次讀完。
 *
 * 地圖那一頁要同時畫出倉位、地圖標示、每個倉位裡有什麼、還有畫布尺寸。拆成五支
 * API 的話畫面會一格一格跳出來，而且中間那幾個瞬間的地圖是錯的（有倉位、沒東西）。
 */
async function loadTargetWarehouse(db: Database): Promise<WarehouseSnapshot> {
  const [layout] = await db.select().from(wmsLayouts).where(eq(wmsLayouts.active, 1)).orderBy(asc(wmsLayouts.id)).limit(1);
  const [zoneRows, elementRows, categoryRows, itemRows, shelfRows, imageRows] = await Promise.all([
    db.select().from(wmsZones).orderBy(asc(wmsZones.code)),
    db.select().from(wmsLayoutElements).orderBy(asc(wmsLayoutElements.zIndex), asc(wmsLayoutElements.label)),
    db.select().from(wmsCategories).orderBy(asc(wmsCategories.name)),
    db.select({ wms: wmsItems, item: itemMasters }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).orderBy(asc(itemMasters.name)),
    db.select().from(wmsShelves).orderBy(asc(wmsShelves.zoneId), asc(wmsShelves.sortOrder)),
    db.select({ zoneId: wmsZoneImages.zoneId, total: count() }).from(wmsZoneImages).groupBy(wmsZoneImages.zoneId),
  ]);
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
    layoutElements: elementRows,
    categories: categoryRows,
    items: itemRows.map(({ wms, item }) => {
      const shelf = wms.shelfId ? shelfById.get(wms.shelfId) : undefined;
      const category = wms.wmsCategoryId ? categoryRows.find((candidate) => candidate.id === wms.wmsCategoryId) : undefined;
      return { id: item.id, sku: item.sku, name: item.name, category: category?.name ?? "未分類", quantity: wms.quantity, unit: wms.unit, minStock: wms.minStock, zoneId: shelf?.zoneId ?? null, shelfLevel: shelf?.code ?? null, notes: wms.notes, updatedAt: wms.updatedAt, cyberbiz: null };
    }),
  };
}

export async function loadWarehouse(db: Database): Promise<WarehouseSnapshot> {
  const [targetZone] = await db.select({ id: wmsZones.id }).from(wmsZones).limit(1);
  const [targetItem] = await db.select({ id: wmsItems.itemId }).from(wmsItems).limit(1);
  // 舊測試／尚未搬移的空資料庫仍可能只有由 trigger 建出的 target zone；有 target item 才切換完整 target 讀取。
  if (targetZone && targetItem) return loadTargetWarehouse(db);
  const [settingsRow] = await db
    .select()
    .from(warehouseSettings)
    .where(eq(warehouseSettings.id, SETTINGS_ID));

  const [zoneRows, elementRows, categoryRows, itemRows, imageCounts, linkRows, targetRows, targetItemRows, targetCategoryRows, targetShelfRows] = await Promise.all([
    db.select().from(zones).orderBy(asc(zones.code)),
    db.select().from(layoutElements).orderBy(asc(layoutElements.label)),
    db.select().from(warehouseCategories).orderBy(asc(warehouseCategories.name)),
    db.select().from(inventoryItems).orderBy(asc(inventoryItems.name)),
    // 只要數量：地圖上每個倉位顯示一個相機圖示與張數，不需要圖片本身。
    db.select({ zoneId: zoneImages.zoneId, total: count() }).from(zoneImages).groupBy(zoneImages.zoneId),
    /*
     * 連結另外查一次，不 join 在商品上。
     *
     * join 的話兩張表都有 sku 欄位，回來的結果會對映錯位——這在 listCompanyLinks
     * 踩過一次（quantity 拿到 minStock 的值）。分開查再自己配對，沒有那個問題。
     */
    db.select().from(cyberbizProductLinks),
    db.select().from(wmsItems),
    db.select().from(itemMasters),
    db.select().from(wmsCategories),
    db.select().from(wmsShelves),
  ]);

  const imagesByZone = new Map(imageCounts.map((row) => [row.zoneId, row.total]));
  const targetItemsById = new Map(targetItemRows.map((row) => [row.id, row]));
  const targetCategoriesById = new Map(targetCategoryRows.map((row) => [row.id, row]));
  const targetShelvesById = new Map(targetShelfRows.map((row) => [row.id, row]));
  const linksByItem = new Map(linkRows.map((link) => [link.inventoryItemId, link]));
  const legacySkus = new Set(itemRows.map((item) => item.sku).filter((sku): sku is string => Boolean(sku)));
  const projectedTargetItems = targetRows
    .map((wmsItem) => {
      const item = targetItemsById.get(wmsItem.itemId);
      const shelf = wmsItem.shelfId ? targetShelvesById.get(wmsItem.shelfId) : undefined;
      const category = wmsItem.wmsCategoryId ? targetCategoriesById.get(wmsItem.wmsCategoryId) : undefined;
      return { wmsItem, item, shelf, category };
    })
    .filter((row) => row.item && !legacySkus.has(row.item.sku))
    .map(({ wmsItem, item, shelf, category }) => ({
      id: wmsItem.itemId,
      sku: item!.sku,
      name: item!.name,
      category: category?.name ?? "未分類",
      quantity: wmsItem.quantity,
      unit: wmsItem.unit,
      minStock: wmsItem.minStock,
      zoneId: shelf?.zoneId ?? null,
      shelfLevel: shelf?.code ?? null,
      notes: wmsItem.notes,
      updatedAt: wmsItem.updatedAt,
      cyberbiz: null,
    }));
  return {
    // 設定那一列可能還沒建（全新的資料庫），給預設值而不是回 null。
    settings: {
      canvasWidth: settingsRow?.canvasWidth ?? CANVAS.width.fallback,
      canvasHeight: settingsRow?.canvasHeight ?? CANVAS.height.fallback,
    },
    zones: zoneRows.map((zone) => ({
      ...zone,
      shelfLevels: parseShelfLevels(zone.shelfLevels),
      imageCount: imagesByZone.get(zone.id) ?? 0,
    })),
    layoutElements: elementRows,
    categories: categoryRows,
    items: [
      ...itemRows.map((item) => {
        const link = linksByItem.get(item.id);
        return {
          ...item,
          cyberbiz: link
            ? {
                cyberbizProductId: link.cyberbizProductId,
                cyberbizVariantId: link.cyberbizVariantId,
                sku: link.sku,
                syncStatus: link.syncStatus,
                lastSyncedQuantity: link.lastSyncedQuantity,
                lastSyncedAt: link.lastSyncedAt,
                lastError: link.lastError,
              }
            : null,
        };
      }),
      ...projectedTargetItems,
    ],
  };
}

// ───────────────────────────── 倉位 ─────────────────────────────

export interface ZoneInput {
  code: string;
  name: string;
  category?: string;
  color?: string;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  shelfLevels?: unknown;
  notes?: string;
}

export async function createZone(db: Database, input: ZoneInput & { actor: Actor }) {
  const id = crypto.randomUUID();
  // 代碼一律大寫：人會打 a-01 也會打 A-01，不統一的話 unique 擋不住重複。
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();

  const parsedShelves = normalizeShelfLevels(input.shelfLevels);
  const zone = {
    id,
    code,
    name,
    category: input.category?.trim() || "一般備品",
    color: input.color?.trim() || "mint",
    x: clamp(input.x, 38, BOUNDS.x),
    y: clamp(input.y, 38, BOUNDS.y),
    width: clamp(input.width, 18, BOUNDS.width),
    height: clamp(input.height, 16, BOUNDS.height),
    shelfLevels: JSON.stringify(parsedShelves),
    notes: input.notes?.trim() || "",
  };

  await db.batch([
    db.insert(zones).values(zone),
    db.insert(wmsLayouts).values({ id: "layout:main", name: "主倉庫", canvasWidth: CANVAS.width.fallback, canvasHeight: CANVAS.height.fallback, active: 1 }).onConflictDoNothing(),
    db.insert(wmsZones).values({ id, code, name, color: zone.color, notes: zone.notes, active: 1 }).onConflictDoNothing(),
    db.insert(wmsLayoutElements).values({ id: `wms-zone:${id}`, layoutId: "layout:main", elementType: "zone", zoneId: id, label: name, color: zone.color, x: zone.x, y: zone.y, width: zone.width, height: zone.height, zIndex: 0 }).onConflictDoNothing(),
    ...parsedShelves.map((shelf, index) =>
      db.insert(wmsShelves).values({
        id: crypto.randomUUID(),
        zoneId: id,
        code: shelf.id,
        name: shelf.name,
        sortOrder: index,
        active: 1,
      }).onConflictDoNothing(),
    ),
    writeEvent(db, {
      entityType: "zone",
      entityId: id,
      entityLabel: `${code} ${name}`,
      eventType: "zone_created",
      summary: "新增倉位",
      payload: zone,
      actor: input.actor,
    }),
  ]);

  return { id };
}

export async function updateZone(
  db: Database,
  id: string,
  input: Partial<ZoneInput> & { actor: Actor },
) {
  const [current] = await db.select().from(zones).where(eq(zones.id, id));
  if (!current) throw new WmsError("not_found", "找不到這個倉位。");

  const shelfLevels =
    input.shelfLevels === undefined
      ? parseShelfLevels(current.shelfLevels)
      : normalizeShelfLevels(input.shelfLevels, parseShelfLevels(current.shelfLevels));

  /*
   * 要移除的層還有東西放著就擋下來。
   *
   * 放行的話那些品項的 shelf_level 會指向一個不存在的層——不會報錯，只是從此
   * 「不在任何一層」，等到有人去現場找不到東西才會發現。
   */
  if (input.shelfLevels !== undefined) {
    const allowed = new Set(shelfLevels.map((level) => level.id));
    const inUse = await db
      .selectDistinct({ shelfLevel: inventoryItems.shelfLevel })
      .from(inventoryItems)
      .where(eq(inventoryItems.zoneId, id));

    // shelf_level 可以是 null（放在這一區但沒指定層），那種不算佔用任何一層。
    const blocked = inUse
      .map((row) => row.shelfLevel)
      .filter((level): level is string => level !== null && !allowed.has(level));
    if (blocked.length) {
      throw new WmsError("conflict", "還有商品放在要移除的層架上，請先把商品移到別層。");
    }
  }

  const next = {
    code: (input.code?.trim() || current.code).toUpperCase(),
    name: input.name?.trim() || current.name,
    category: input.category?.trim() || current.category,
    color: input.color?.trim() || current.color,
    x: clamp(input.x, current.x, BOUNDS.x),
    y: clamp(input.y, current.y, BOUNDS.y),
    width: clamp(input.width, current.width, BOUNDS.width),
    height: clamp(input.height, current.height, BOUNDS.height),
    shelfLevels: JSON.stringify(shelfLevels),
    notes: input.notes === undefined ? current.notes : input.notes.trim(),
  };

  /*
   * 拖曳與縮放分開記。地圖上一天可能拖幾十次，全部記成「修改倉位」的話，
   * 想找「這個倉位的資料是什麼時候改的」會被淹沒在位置紀錄裡。
   */
  const moved = input.x !== undefined || input.y !== undefined;
  const resized = input.width !== undefined || input.height !== undefined;

  await db.batch([
    db.update(zones).set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(zones.id, id)),
    db
      .update(wmsZones)
      .set({
        code: next.code,
        name: next.name,
        color: next.color,
        notes: next.notes,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(wmsZones.id, id)),
    db
      .insert(wmsLayoutElements)
      .values({ id: `wms-zone:${id}`, layoutId: "layout:main", elementType: "zone", zoneId: id, label: next.name, color: next.color, x: next.x, y: next.y, width: next.width, height: next.height, zIndex: 0 })
      .onConflictDoUpdate({ target: wmsLayoutElements.id, set: { label: next.name, color: next.color, x: next.x, y: next.y, width: next.width, height: next.height, updatedAt: sql`CURRENT_TIMESTAMP` } }),
    ...shelfLevels.map((shelf, index) =>
      db.insert(wmsShelves).values({
        id: crypto.randomUUID(),
        zoneId: id,
        code: shelf.id,
        name: shelf.name,
        sortOrder: index,
        active: 1,
      }).onConflictDoUpdate({
        target: [wmsShelves.zoneId, wmsShelves.code],
        set: { name: shelf.name, sortOrder: index, updatedAt: sql`CURRENT_TIMESTAMP` },
      }),
    ),
    writeEvent(db, {
      entityType: "zone",
      entityId: id,
      entityLabel: `${next.code} ${next.name}`,
      eventType: moved ? "zone_moved" : resized ? "zone_resized" : "zone_updated",
      summary: moved ? "移動倉位" : resized ? "調整倉位大小" : "修改倉位資料",
      field: moved ? "position" : resized ? "size" : "details",
      // 移動與縮放寫得出「從哪到哪」；改資料的變更太雜，只留快照。
      oldValue: moved ? asPosition(current as { x: number; y: number }) : resized ? asSize(current as { width: number; height: number }) : null,
      newValue: moved ? asPosition(next as { x: number; y: number }) : resized ? asSize(next as { width: number; height: number }) : null,
      payload: { before: current, after: next },
      actor: input.actor,
    }),
  ]);
}

/**
 * 刪倉位。
 *
 * 資料表那邊已經有 onDelete: restrict 擋著，但那道關丟出來的是一句 SQLite 的
 * 英文錯誤。這裡先自己查一次是為了給人看得懂的話，不是為了取代那道關。
 */
export async function deleteZone(db: Database, id: string, actor: Actor) {
  const [zone] = await db.select().from(zones).where(eq(zones.id, id));
  if (!zone) throw new WmsError("not_found", "找不到這個倉位。");

  const [items] = await db
    .select({ total: count() })
    .from(inventoryItems)
    .where(eq(inventoryItems.zoneId, id));
  if ((items?.total ?? 0) > 0) {
    throw new WmsError("conflict", `這個倉位還有 ${items?.total} 項商品，請先移到別的倉位。`);
  }

  await db.batch([
    // zone_images 是 cascade；物件與 media metadata 由 route 在外部刪除成功後另外清理。
    db.delete(zones).where(eq(zones.id, id)),
    db.delete(wmsLayoutElements).where(eq(wmsLayoutElements.zoneId, id)),
    db.delete(wmsShelves).where(eq(wmsShelves.zoneId, id)),
    db.delete(wmsZones).where(eq(wmsZones.id, id)),
    writeEvent(db, {
      entityType: "zone",
      entityId: id,
      entityLabel: `${zone.code} ${zone.name}`,
      eventType: "zone_deleted",
      summary: "刪除倉位",
      payload: zone,
      actor,
    }),
  ]);
}

// ───────────────────────────── 庫存品項 ─────────────────────────────

export interface ItemInput {
  sku?: string;
  name: string;
  category: string;
  quantity?: unknown;
  unit?: string;
  minStock?: unknown;
  zoneId?: string | null;
  shelfLevel?: string | null;
  notes?: string;
}

/**
 * 檢查倉位與層架配不配。
 *
 * 層架 id 存在 inventory_items.shelf_level，是一個沒有外鍵的字串——沒有這道檢查，
 * 打錯的層架 id 會安靜地存進去。
 */
async function hasTable(db: Database, name: string): Promise<boolean> {
  const row = await db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name} LIMIT 1`);
  return Boolean(row);
}

async function resolvePlacement(db: Database, zoneId: string | null, shelfLevel: string | null) {
  if (!zoneId) return { zoneId: null, shelfLevel: null };

  const [targetZone] = await db.select({ id: wmsZones.id }).from(wmsZones).where(eq(wmsZones.id, zoneId));
  if (targetZone) {
    if (!shelfLevel) return { zoneId, shelfLevel: null };
    const [shelf] = await db.select({ code: wmsShelves.code }).from(wmsShelves).where(and(eq(wmsShelves.zoneId, zoneId), eq(wmsShelves.code, shelfLevel))).limit(1);
    return { zoneId, shelfLevel: shelf?.code ?? null };
  }

  const [zone] = await db
    .select({ shelfLevels: zones.shelfLevels })
    .from(zones)
    .where(eq(zones.id, zoneId));
  if (!zone) throw new WmsError("invalid", "找不到指定的倉位。");

  const levels = parseShelfLevels(zone.shelfLevels);
  // 沒選層、或選了不存在的層，就當作「放在這一區但沒指定層」，不要整筆擋掉。
  return {
    zoneId,
    shelfLevel: shelfLevel && levels.some((level) => level.id === shelfLevel) ? shelfLevel : null,
  };
}

/** 分類存的是名字不是外鍵，所以要自己確認它真的在分類表裡。 */
async function requireCategory(db: Database, name: string) {
  const [target] = await db.select({ id: wmsCategories.id }).from(wmsCategories).where(eq(wmsCategories.name, name));
  if (target) return target.id;
  const [legacy] = await db.select({ id: warehouseCategories.id }).from(warehouseCategories).where(eq(warehouseCategories.name, name));
  if (!legacy) throw new WmsError("invalid", "請選一個已經建立的倉儲分類。");
  return legacy.id;
}

/** target schema 的品項沒有 legacy inventory_items 的 zone 欄位，位置要從 shelf 反查。 */
async function resolveTargetShelf(db: Database, zoneId: string | null, shelfCode: string | null) {
  if (!zoneId || !shelfCode) return null;
  const [shelf] = await db
    .select({ id: wmsShelves.id })
    .from(wmsShelves)
    .innerJoin(wmsZones, eq(wmsZones.id, wmsShelves.zoneId))
    .where(and(eq(wmsZones.id, zoneId), eq(wmsShelves.code, shelfCode)))
    .limit(1);
  if (!shelf) throw new WmsError("invalid", "找不到指定的層架。");
  return shelf.id;
}

/**
 * 外部 SKU 與自訂 SKU 都不能被另一個商品的正式 WMS SKU 佔用。
 *
 * 兩邊撞在一起的話會寫進同一個 report_sales_monthly.sku 卻帶不同的名稱與分類，
 * 報表就有兩個互相競爭的來源。這道檢查是商品這一側；對應那一側在
 * product-sku-mappings.ts 的 requireExternalSkuAvailable 與 prepareComponentRows。
 */
async function requireSkuAvailableForExternalMappings(db: Database, sku: string | null, inventoryItemId?: string) {
  if (!sku) return;
  const conflicting = await db
    .select({ channel: productSkuMappings.channel, externalSku: productSkuMappings.externalSku })
    .from(productSkuMappings)
    .leftJoin(productBundleComponents, and(
      eq(productBundleComponents.mappingId, productSkuMappings.id),
      inventoryItemId ? eq(productBundleComponents.inventoryItemId, inventoryItemId) : sql`0`,
    ))
    .where(and(eq(productSkuMappings.externalSku, sku), isNull(productBundleComponents.mappingId)))
    .limit(1);
  const owner = conflicting[0];
  if (owner) {
    throw new WmsError(
      "conflict",
      `WMS SKU「${sku}」已被外部 SKU 對應「${owner.channel} · ${owner.externalSku}」使用。`,
    );
  }

  const [customOwner] = await db
    .select({ sku: customReportProducts.sku, name: customReportProducts.name })
    .from(customReportProducts)
    .where(eq(customReportProducts.sku, sku))
    .limit(1);
  if (customOwner) {
    throw new WmsError(
      "conflict",
      `WMS SKU「${sku}」已被自訂商品主檔「${customOwner.name}」使用，請先改掉那筆自訂 SKU。`,
    );
  }
}

export async function createItem(db: Database, input: ItemInput & { actor: Actor }) {
  const name = input.name.trim();
  const category = input.category.trim();
  await requireCategory(db, category);

  const placement = await resolvePlacement(db, input.zoneId?.trim() || null, input.shelfLevel ?? null);
  const id = crypto.randomUUID();
  // SKU 跟倉位代碼一樣一律大寫，不然 unique 擋不住大小寫不同的同一個 SKU。
  const sku = input.sku?.trim().toUpperCase() || null;

  const item = {
    id,
    sku,
    name,
    category,
    quantity: clamp(input.quantity, 0, QUANTITY),
    unit: input.unit?.trim() || "件",
    minStock: clamp(input.minStock, 5, QUANTITY),
    zoneId: placement.zoneId,
    shelfLevel: placement.shelfLevel,
    notes: input.notes?.trim() || "",
  };
  await requireSkuAvailableForExternalMappings(db, sku);

  const [wmsCat] = await db
    .select({ id: wmsCategories.id })
    .from(wmsCategories)
    .where(eq(wmsCategories.name, category))
    .limit(1);

  let shelfId: string | null = null;
  if (placement.zoneId && placement.shelfLevel) {
    const [shelf] = await db
      .select({ id: wmsShelves.id })
      .from(wmsShelves)
      .where(and(eq(wmsShelves.zoneId, placement.zoneId), eq(wmsShelves.code, placement.shelfLevel)))
      .limit(1);
    shelfId = shelf?.id ?? null;
  }

  const targetSku = sku || `WMS-${id.slice(0, 8).toUpperCase()}`;
  const targetItem = {
    id,
    source: "custom" as const,
    kind: sku ? ("sellable" as const) : ("supply" as const),
    sku: targetSku,
    name,
    categoryId: null,
    active: 1,
  };
  const targetWms = {
    itemId: id,
    wmsCategoryId: wmsCat?.id ?? null,
    shelfId,
    quantity: item.quantity,
    unit: item.unit,
    minStock: item.minStock,
    notes: item.notes,
  };
  const legacyInventoryExists = await hasTable(db, "inventory_items");

  await db.batch([
    db.insert(itemMasters).values(targetItem).onConflictDoNothing(),
    db.insert(wmsItems).values(targetWms).onConflictDoNothing(),
    ...(legacyInventoryExists ? [db.insert(inventoryItems).values(item)] : []),
    writeEvent(db, {
      entityType: "inventory_item",
      entityId: id,
      entityLabel: sku ? `${sku} ${name}` : name,
      eventType: "item_created",
      summary: "新增庫存商品",
      payload: item,
      actor: input.actor,
    }),
  ]);

  return { id };
}

export async function updateItem(
  db: Database,
  id: string,
  input: Partial<ItemInput> & { actor: Actor },
) {
  const legacyInventoryExists = await hasTable(db, "inventory_items");
  const [current] = legacyInventoryExists
    ? await db.select().from(inventoryItems).where(eq(inventoryItems.id, id))
    : [];
  if (!current) {
    const [target] = await db
      .select({ item: itemMasters, wms: wmsItems, category: wmsCategories.name, shelf: wmsShelves })
      .from(wmsItems)
      .innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId))
      .leftJoin(wmsCategories, eq(wmsCategories.id, wmsItems.wmsCategoryId))
      .leftJoin(wmsShelves, eq(wmsShelves.id, wmsItems.shelfId))
      .where(eq(wmsItems.itemId, id)).limit(1);
    if (!target) throw new WmsError("not_found", "找不到這項商品。");
    const category = input.category?.trim() || target.category || "";
    const wmsCategoryId = category ? await requireCategory(db, category) : null;
    const zoneId = input.zoneId === undefined ? target.shelf?.zoneId ?? null : input.zoneId?.trim() || null;
    const shelfLevel = input.shelfLevel === undefined ? target.shelf?.code ?? null : input.shelfLevel;
    const shelfId = await resolveTargetShelf(db, zoneId, shelfLevel ?? null);
    const nextName = input.name?.trim() || target.item.name;
    const nextSku = input.sku === undefined ? target.item.sku : input.sku.trim().toUpperCase();
    if (nextSku !== target.item.sku) await requireSkuAvailableForExternalMappings(db, nextSku, id);
    const nextMinStock = clamp(input.minStock, target.wms.minStock, QUANTITY);
    await db.batch([
      db.update(itemMasters).set({ name: nextName, sku: nextSku, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(itemMasters.id, id)),
      db.update(wmsItems).set({ wmsCategoryId, shelfId, unit: input.unit?.trim() || target.wms.unit, minStock: nextMinStock, notes: input.notes === undefined ? target.wms.notes : input.notes.trim(), updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsItems.itemId, id)),
      writeEvent(db, { entityType: "inventory_item", entityId: id, entityLabel: `${nextSku} ${nextName}`, eventType: "item_updated", summary: "修改商品資料", payload: { before: target, after: { name: nextName, sku: nextSku, wmsCategoryId, shelfId } }, actor: input.actor }),
    ]);
    return;
  }

  const category = input.category?.trim() || current.category;
  if (category !== current.category) await requireCategory(db, category);

  const zoneId = input.zoneId === undefined ? current.zoneId : input.zoneId?.trim() || null;
  const shelfLevel = input.shelfLevel === undefined ? current.shelfLevel : input.shelfLevel;
  const placement = await resolvePlacement(db, zoneId, shelfLevel ?? null);

  /*
   * 已連結的商品不能在這裡改安全庫存。
   *
   * **官網是安全庫存的真相來源**，跟數量一樣（見 wms-sync.ts）。在這裡改的話
   * 有兩件事會發生：不會推上官網，而且下次同步就被官網的值蓋回去——改動不是
   * 沒生效，是會消失。與其讓它安靜地消失，不如當場說清楚。
   *
   * 只有真的要改成不同的值才擋。表單會把整份欄位送回來，其中包含沒有變動的
   * 安全庫存；那種情況不該報錯。
   */
  const wantsMinStock = clamp(input.minStock, current.minStock, QUANTITY);
  if (wantsMinStock !== current.minStock) {
    const [link] = await db
      .select({ id: cyberbizProductLinks.id })
      .from(cyberbizProductLinks)
      .where(eq(cyberbizProductLinks.inventoryItemId, id))
      .limit(1);
    if (link) {
      throw new WmsError(
        "conflict",
        "這項商品已連結 CYBERBIZ，安全庫存以官網為準，請到官網修改。",
      );
    }
  }

  /*
   * 數量不在這裡改，要走 countItem。
   *
   * 「編輯商品資料」與「盤點」是兩件事，權限也不同（wms:inventory:write 與
   * wms:inventory:count）。混在一起的話，只該盤點的人送一個 quantity 就順便
   * 把別的欄位一起改掉了。
   */
  const next = {
    sku: input.sku === undefined ? current.sku : input.sku.trim().toUpperCase() || null,
    name: input.name?.trim() || current.name,
    category,
    unit: input.unit?.trim() || current.unit,
    minStock: wantsMinStock,
    zoneId: placement.zoneId,
    shelfLevel: placement.shelfLevel,
    notes: input.notes === undefined ? current.notes : input.notes.trim(),
  };

  if (input.sku !== undefined && !next.sku) {
    const [mappingUse] = await db
      .select({ channel: productSkuMappings.channel, externalSku: productSkuMappings.externalSku })
      .from(productBundleComponents)
      .innerJoin(productSkuMappings, eq(productSkuMappings.id, productBundleComponents.mappingId))
      .where(eq(productBundleComponents.inventoryItemId, id))
      .limit(1);
    if (mappingUse) {
      throw new WmsError(
        "conflict",
        `這項商品仍是外部 SKU 對應「${mappingUse.channel} · ${mappingUse.externalSku}」的用料，不能清空 WMS SKU。`,
      );
    }
  }
  /*
   * 只在 SKU 真的變動時才檢查佔用。
   *
   * 無條件跑的話，0054 回填（external_sku 取自 cyberbiz_product_links.sku）製造出
   * 「別人的 mapping 外部 SKU 剛好等於本商品 WMS SKU」的舊資料時，這個商品的每一次
   * PATCH——改備註、移倉位——都會 409，而且從商品表單沒有任何辦法修好。
   */
  if (next.sku !== current.sku) {
    await requireSkuAvailableForExternalMappings(db, next.sku, id);
  }

  const moved = next.zoneId !== current.zoneId || next.shelfLevel !== current.shelfLevel;

  let shelfId: string | null = null;
  if (placement.zoneId && placement.shelfLevel) {
    const [shelf] = await db
      .select({ id: wmsShelves.id })
      .from(wmsShelves)
      .where(and(eq(wmsShelves.zoneId, placement.zoneId), eq(wmsShelves.code, placement.shelfLevel)))
      .limit(1);
    shelfId = shelf?.id ?? null;
  }
  const [wmsCat] = await db
    .select({ id: wmsCategories.id })
    .from(wmsCategories)
    .where(eq(wmsCategories.name, category))
    .limit(1);

  await db.batch([
    db
      .update(inventoryItems)
      .set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(inventoryItems.id, id)),
    db
      .update(itemMasters)
      .set({
        name: next.name,
        ...(next.sku ? { sku: next.sku } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(itemMasters.id, id)),
    db
      .update(wmsItems)
      .set({
        wmsCategoryId: wmsCat?.id ?? null,
        shelfId,
        unit: next.unit,
        minStock: wantsMinStock,
        notes: next.notes,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(wmsItems.itemId, id)),
    writeEvent(db, {
      entityType: "inventory_item",
      entityId: id,
      entityLabel: next.sku ? `${next.sku} ${next.name}` : next.name,
      eventType: moved ? "item_moved" : "item_updated",
      summary: moved ? "調整商品存放位置" : "修改商品資料",
      field: moved ? "placement" : "details",
      payload: { before: current, after: next },
      actor: input.actor,
    }),
  ]);
}

export async function deleteItem(db: Database, id: string, actor: Actor) {
  const legacyInventoryExists = await hasTable(db, "inventory_items");
  const [item] = legacyInventoryExists
    ? await db.select().from(inventoryItems).where(eq(inventoryItems.id, id))
    : [];
  if (!item) {
    const [target] = await db.select({ item: itemMasters }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, id)).limit(1);
    if (!target) throw new WmsError("not_found", "找不到這項商品。");
    const [componentUse] = await db.select({ parentItemId: itemComponents.parentItemId }).from(itemComponents).where(eq(itemComponents.componentItemId, id)).limit(1);
    if (componentUse) throw new WmsError("conflict", "這項商品仍是 BOM 用料，請先移除組成後再移出倉儲。");
    await db.batch([
      // 移出倉儲不等於刪除平台品項；CYBERBIZ item 必須保留給報表與下次納入倉儲使用。
      db.delete(wmsItems).where(eq(wmsItems.itemId, id)),
      writeEvent(db, { entityType: "inventory_item", entityId: id, entityLabel: `${target.item.sku} ${target.item.name}`, eventType: "item_deleted", summary: "移出倉儲", payload: target.item, actor }),
    ]);
    return;
  }
  /*
   * 只要還被任何一筆對應當成用料就擋，並指出是哪一筆。
   *
   * 舊版有「主商品」的概念，刪掉主商品會連帶刪掉整筆對應——但那個「主商品」只是存檔
   * 當下的第一列用料，同一個動作的後果會隨著排序改變。現在一律要求先去 SKU 對應頁處理，
   * 行為固定，而且訊息說得出是哪一筆擋住（商品頁本來就看不到對應了）。
   */
  const [componentUse] = await db
    .select({ channel: productSkuMappings.channel, externalSku: productSkuMappings.externalSku })
    .from(productBundleComponents)
    .innerJoin(productSkuMappings, eq(productSkuMappings.id, productBundleComponents.mappingId))
    .where(eq(productBundleComponents.inventoryItemId, id))
    .limit(1);
  if (componentUse) {
    throw new WmsError(
      "conflict",
      `這項商品仍是外部 SKU 對應「${componentUse.channel} · ${componentUse.externalSku}」的用料，請先在 SKU 對應頁移除再刪除。`,
    );
  }

  await db.batch([
    db.delete(inventoryItems).where(eq(inventoryItems.id, id)),
    db.delete(wmsItems).where(eq(wmsItems.itemId, id)),
    db.delete(itemMasters).where(eq(itemMasters.id, id)),
    writeEvent(db, {
      entityType: "inventory_item",
      entityId: id,
      entityLabel: item.sku ? `${item.sku} ${item.name}` : item.name,
      eventType: "item_deleted",
      summary: "刪除庫存商品",
      payload: item,
      actor,
    }),
  ]);
}

/**
 * 盤點。只改數量，其他欄位一概不動。
 *
 * 數量沒變也照樣寫一筆紀錄——「今天數過，結果沒變」跟「今天沒數」是兩件事，
 * 只記變化的話，盤點紀錄就沒辦法拿來證明有盤過。
 */
export async function countItem(
  db: Database,
  id: string,
  quantity: unknown,
  actor: Actor,
  note?: string,
) {
  const parsed = Number(quantity);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new WmsError("invalid", "盤點數量必須是 0 或正整數。");
  }

  const legacyInventoryExists = await hasTable(db, "inventory_items");
  const [item] = legacyInventoryExists
    ? await db.select().from(inventoryItems).where(eq(inventoryItems.id, id))
    : [];
  if (!item) {
    const [target] = await db.select({ item: itemMasters, wms: wmsItems }).from(wmsItems).innerJoin(itemMasters, eq(itemMasters.id, wmsItems.itemId)).where(eq(wmsItems.itemId, id)).limit(1);
    if (!target) throw new WmsError("not_found", "找不到這項商品。");
    const next = clamp(parsed, 0, QUANTITY);
    const changed = target.wms.quantity !== next;
    await db.batch([
      db.update(wmsItems).set({ quantity: next, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(wmsItems.itemId, id)),
      writeEvent(db, { entityType: "inventory_item", entityId: id, entityLabel: `${target.item.sku} ${target.item.name}`, eventType: "item_counted", summary: note?.trim() || (changed ? "盤點更新庫存數量" : "盤點確認數量無誤"), field: "quantity", oldValue: String(target.wms.quantity), newValue: String(next), actor }),
    ]);
    return { quantity: next, changed, belowMinimum: next < target.wms.minStock };
  }

  const next = clamp(parsed, 0, QUANTITY);
  const changed = item.quantity !== next;

  await db.batch([
    db
      .update(inventoryItems)
      .set({ quantity: next, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(inventoryItems.id, id)),
    db
      .update(wmsItems)
      .set({ quantity: next, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(wmsItems.itemId, id)),
    writeEvent(db, {
      entityType: "inventory_item",
      entityId: id,
      entityLabel: item.sku ? `${item.sku} ${item.name}` : item.name,
      eventType: "item_counted",
      summary: note?.trim() || (changed ? "盤點更新庫存數量" : "盤點確認數量無誤"),
      field: "quantity",
      oldValue: String(item.quantity),
      newValue: String(next),
      actor,
    }),
  ]);

  // belowMinimum 給呼叫端提示用。低於安全庫存不是錯誤，盤點照樣成立。
  return { quantity: next, changed, belowMinimum: next < item.minStock };
}

// ───────────────────────────── 倉儲分類 ─────────────────────────────

/** 分類的顏色。限制成一組固定值，不然畫面上會出現十七種深淺不一的紅色。 */
export const WAREHOUSE_CATEGORY_COLORS = [
  "rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand",
] as const;

function normalizeColor(value: unknown, fallback: string): string {
  const color = String(value ?? "");
  return (WAREHOUSE_CATEGORY_COLORS as readonly string[]).includes(color) ? color : fallback;
}

export async function createWarehouseCategory(
  db: Database,
  input: { name: string; color?: unknown; actor: Actor },
) {
  const name = input.name.trim().slice(0, 40);
  const category = { id: crypto.randomUUID(), name, color: normalizeColor(input.color, "rose") };

  const legacyCategoriesExists = await hasTable(db, "warehouse_categories");
  await db.batch([
    db.insert(wmsCategories).values({ id: category.id, name, color: category.color, active: 1 }).onConflictDoNothing(),
    ...(legacyCategoriesExists ? [db.insert(warehouseCategories).values(category)] : []),
    writeEvent(db, {
      entityType: "warehouse_category",
      entityId: category.id,
      entityLabel: name,
      eventType: "warehouse_category_created",
      summary: "新增倉儲分類",
      payload: category,
      actor: input.actor,
    }),
  ]);

  return { id: category.id };
}

/**
 * 改分類。
 *
 * 改名時要順手把所有品項的 category 一起改掉——那個欄位存的是**名字**不是外鍵，
 * 少了這一步，舊名字的品項會從此不屬於任何分類。
 */
export async function updateWarehouseCategory(
  db: Database,
  id: string,
  input: { name?: string; color?: unknown; actor: Actor },
) {
  const legacyCategoriesExists = await hasTable(db, "warehouse_categories");
  const [current] = legacyCategoriesExists
    ? await db.select().from(warehouseCategories).where(eq(warehouseCategories.id, id))
    : await db.select().from(wmsCategories).where(eq(wmsCategories.id, id));
  if (!current) throw new WmsError("not_found", "找不到這個倉儲分類。");

  const next = {
    name: input.name?.trim().slice(0, 40) || current.name,
    color: normalizeColor(input.color, current.color),
  };
  const renamed = next.name !== current.name;

  await db.batch([
    db
      .update(wmsCategories)
      .set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(wmsCategories.id, id)),
    ...(legacyCategoriesExists
      ? [
        db.update(warehouseCategories).set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(warehouseCategories.id, id)),
        db.update(inventoryItems).set({ category: next.name, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(inventoryItems.category, current.name)),
      ]
      : []),
    writeEvent(db, {
      entityType: "warehouse_category",
      entityId: id,
      entityLabel: next.name,
      eventType: "warehouse_category_updated",
      summary: renamed ? "重新命名倉儲分類" : "修改倉儲分類顏色",
      field: renamed ? "name" : "color",
      oldValue: renamed ? current.name : current.color,
      newValue: renamed ? next.name : next.color,
      payload: { before: current, after: next },
      actor: input.actor,
    }),
  ]);
}

export async function deleteWarehouseCategory(db: Database, id: string, actor: Actor) {
  const legacyCategoriesExists = await hasTable(db, "warehouse_categories");
  const [category] = legacyCategoriesExists
    ? await db.select().from(warehouseCategories).where(eq(warehouseCategories.id, id))
    : await db.select().from(wmsCategories).where(eq(wmsCategories.id, id));
  if (!category) throw new WmsError("not_found", "找不到這個倉儲分類。");

  // target 以外鍵保存分類，legacy 則以名稱保存；兩種資料都要阻擋正在使用的分類。
  const [usage] = legacyCategoriesExists
    ? await db.select({ total: count() }).from(inventoryItems).where(eq(inventoryItems.category, category.name))
    : await db.select({ total: count() }).from(wmsItems).where(eq(wmsItems.wmsCategoryId, id));
  if ((usage?.total ?? 0) > 0) {
    throw new WmsError("conflict", `還有 ${usage?.total} 項庫存商品是這個倉儲分類，請先改成別的分類。`);
  }

  await db.batch([
    db.delete(wmsCategories).where(eq(wmsCategories.id, id)),
    ...(legacyCategoriesExists ? [db.delete(warehouseCategories).where(eq(warehouseCategories.id, id))] : []),
    writeEvent(db, {
      entityType: "warehouse_category",
      entityId: id,
      entityLabel: category.name,
      eventType: "warehouse_category_deleted",
      summary: "刪除倉儲分類",
      payload: category,
      actor,
    }),
  ]);
}

// ───────────────────────── 地圖標示與畫布 ─────────────────────────

export interface LayoutElementInput {
  label: string;
  color?: string;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

export async function createLayoutElement(
  db: Database,
  input: LayoutElementInput & { actor: Actor },
) {
  const id = crypto.randomUUID();
  const label = input.label.trim().slice(0, 40);
  const element = {
    id,
    label,
    color: input.color?.trim() || "rose",
    x: clamp(input.x, 10, BOUNDS.x),
    y: clamp(input.y, 10, BOUNDS.y),
    width: clamp(input.width, 12, BOUNDS.width),
    height: clamp(input.height, 10, BOUNDS.height),
  };

  await db.batch([
    db.insert(layoutElements).values(element),
    writeEvent(db, {
      entityType: "layout_element",
      entityId: id,
      entityLabel: label,
      eventType: "element_created",
      summary: "新增地圖標示",
      payload: element,
      actor: input.actor,
    }),
  ]);

  return { id };
}

export async function updateLayoutElement(
  db: Database,
  id: string,
  input: Partial<LayoutElementInput> & { actor: Actor },
) {
  const [current] = await db.select().from(layoutElements).where(eq(layoutElements.id, id));
  if (!current) throw new WmsError("not_found", "找不到這個地圖標示。");

  const next = {
    label: input.label?.trim().slice(0, 40) || current.label,
    color: input.color?.trim() || current.color,
    x: clamp(input.x, current.x, BOUNDS.x),
    y: clamp(input.y, current.y, BOUNDS.y),
    width: clamp(input.width, current.width, BOUNDS.width),
    height: clamp(input.height, current.height, BOUNDS.height),
  };

  await db.batch([
    db
      .update(layoutElements)
      .set({ ...next, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(layoutElements.id, id)),
    writeEvent(db, {
      entityType: "layout_element",
      entityId: id,
      entityLabel: next.label,
      eventType: "element_updated",
      summary: "調整地圖標示",
      payload: { before: current, after: next },
      actor: input.actor,
    }),
  ]);
}

export async function deleteLayoutElement(db: Database, id: string, actor: Actor) {
  const [element] = await db.select().from(layoutElements).where(eq(layoutElements.id, id));
  if (!element) throw new WmsError("not_found", "找不到這個地圖標示。");

  await db.batch([
    db.delete(layoutElements).where(eq(layoutElements.id, id)),
    writeEvent(db, {
      entityType: "layout_element",
      entityId: id,
      entityLabel: element.label,
      eventType: "element_deleted",
      summary: "刪除地圖標示",
      payload: element,
      actor,
    }),
  ]);
}

/**
 * 改畫布尺寸。
 *
 * 那一列可能還不存在（全新的資料庫沒有人設定過），所以用 upsert 而不是 update——
 * update 打不到任何一列時不會報錯，只會安靜地什麼都沒發生。
 */
export async function updateWarehouseSettings(
  db: Database,
  input: { canvasWidth?: unknown; canvasHeight?: unknown; actor: Actor },
) {
  const [current] = await db
    .select()
    .from(warehouseSettings)
    .where(eq(warehouseSettings.id, SETTINGS_ID));

  const next = {
    canvasWidth: clamp(input.canvasWidth, current?.canvasWidth ?? CANVAS.width.fallback, CANVAS.width),
    canvasHeight: clamp(input.canvasHeight, current?.canvasHeight ?? CANVAS.height.fallback, CANVAS.height),
  };

  await db.batch([
    db
      .insert(warehouseSettings)
      .values({ id: SETTINGS_ID, ...next })
      .onConflictDoUpdate({
        target: warehouseSettings.id,
        set: { ...next, updatedAt: sql`CURRENT_TIMESTAMP` },
      }),
    db
      .insert(wmsLayouts)
      .values({ id: "layout:main", name: "主倉庫", ...next, active: 1 })
      .onConflictDoUpdate({
        target: wmsLayouts.id,
        set: { ...next, updatedAt: sql`CURRENT_TIMESTAMP` },
      }),
    writeEvent(db, {
      entityType: "warehouse",
      entityId: SETTINGS_ID,
      entityLabel: "倉庫地圖畫布",
      eventType: "canvas_resized",
      summary: `調整畫布為 ${next.canvasWidth} × ${next.canvasHeight}`,
      field: "canvas",
      oldValue: current ? `${current.canvasWidth} × ${current.canvasHeight}` : null,
      newValue: `${next.canvasWidth} × ${next.canvasHeight}`,
      actor: input.actor,
    }),
  ]);

  return next;
}

// ───────────────────────────── 倉位照片 ─────────────────────────────

/**
 * 照片本身放物件儲存（R2），這張表只存索引。
 *
 * 兩邊要一起成功才算數：先寫 R2 再寫 D1——反過來的話，D1 有一筆指向不存在的
 * 檔案，畫面上會出現一張永遠載不出來的破圖。R2 寫成功但 D1 失敗只是留下一個
 * 沒人參照的檔案，那個安靜得多。
 */
export async function recordZoneImage(
  db: Database,
  input: {
    zoneId: string;
    objectKey: string;
    filename: string;
    contentType: string;
    size: number;
    actor: Actor;
  },
) {
  const [zone] = await db.select({ code: zones.code, name: zones.name }).from(zones).where(eq(zones.id, input.zoneId));
  if (!zone) throw new WmsError("not_found", "找不到這個倉位。");

  const id = crypto.randomUUID();
  await db.batch([
    db.insert(zoneImages).values({
      id,
      zoneId: input.zoneId,
      objectKey: input.objectKey,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
    }),
    writeEvent(db, {
      entityType: "zone",
      entityId: input.zoneId,
      entityLabel: `${zone.code} ${zone.name}`,
      eventType: "image_uploaded",
      summary: "上傳倉位現場照片",
      field: "image",
      newValue: input.filename,
      actor: input.actor,
    }),
  ]);

  return { id };
}

export async function listZoneImages(db: Database, zoneId: string) {
  return db
    .select()
    .from(zoneImages)
    .where(eq(zoneImages.zoneId, zoneId))
    .orderBy(asc(zoneImages.createdAt));
}

export async function findZoneImage(db: Database, id: string) {
  const [row] = await db.select().from(zoneImages).where(eq(zoneImages.id, id));
  return row ?? null;
}

/** 刪照片的 D1 索引；外部物件必須由呼叫端先刪成功，media metadata 才能再清掉。 */
export async function deleteZoneImage(db: Database, id: string, actor: Actor) {
  const [image] = await db.select().from(zoneImages).where(eq(zoneImages.id, id));
  if (!image) throw new WmsError("not_found", "找不到這張照片。");

  const [zone] = await db.select({ code: zones.code, name: zones.name }).from(zones).where(eq(zones.id, image.zoneId));

  await db.batch([
    db.delete(zoneImages).where(eq(zoneImages.id, id)),
    writeEvent(db, {
      entityType: "zone",
      entityId: image.zoneId,
      entityLabel: zone ? `${zone.code} ${zone.name}` : "",
      eventType: "image_deleted",
      summary: "刪除倉位現場照片",
      field: "image",
      oldValue: image.filename,
      actor,
    }),
  ]);

  return { objectKey: image.objectKey };
}

/** 刪倉位之前要把它的照片從 R2 清掉——資料表那邊是 cascade，但 R2 沒有。 */
export async function zoneImageKeys(db: Database, zoneId: string): Promise<string[]> {
  const rows = await db
    .select({ objectKey: zoneImages.objectKey })
    .from(zoneImages)
    .where(eq(zoneImages.zoneId, zoneId));
  return rows.map((row) => row.objectKey);
}
