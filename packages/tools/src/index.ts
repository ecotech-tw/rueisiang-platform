import {
  AssistantError,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
} from "@rueisiang/assistant";
import {
  WMS_ENTITY_TYPES,
  listActivity,
  loadWarehouse,
  type Database,
} from "@rueisiang/db";
import type { ToolContract, ToolContext, ToolSurface } from "./contract.js";

export type PlatformToolDefinition = ToolContract;

function database(context: ToolContext | undefined): Database {
  if (!context?.db) throw new AssistantError("這個工具目前沒有可用的資料來源。");
  return context.db as Database;
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function textInput(input: unknown, key: string): string {
  const value = objectInput(input)[key];
  return typeof value === "string" ? value.trim() : "";
}

function boundedNumber(input: unknown, key: string, fallback: number, max: number): number {
  const raw = textInput(input, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const platformOpenMeteoTool: PlatformToolDefinition = {
  ...openMeteoTool,
  surfaces: ["sandbox", "line", "mcp"],
};

export const WMS_LIST_INVENTORY_TOOL_KEY = "wms_list_inventory";
export const WMS_SEARCH_WAREHOUSE_TOOL_KEY = "wms_search_warehouse";
export const WMS_GET_INVENTORY_ITEM_TOOL_KEY = "wms_get_inventory_item";
export const WMS_LIST_LOW_STOCK_TOOL_KEY = "wms_list_low_stock_items";
export const WMS_GET_ACTIVITY_TOOL_KEY = "wms_get_activity";

const wmsPermission = ["wms:inventory:read"] as const;
const wmsMapPermission = ["wms:map:read"] as const;

const wmsListInventoryTool: PlatformToolDefinition = {
  key: WMS_LIST_INVENTORY_TOOL_KEY,
  label: "WMS 列出商品庫存",
  description: "分頁列出 WMS 商品庫存，適合先取得商品清單，再依 SKU 或商品名稱做 mapping。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: wmsPermission,
  parameters: {
    type: "object",
    properties: {
      page: { type: "string", description: "頁碼，預設 1。" },
      pageSize: { type: "string", description: "每頁筆數，預設 50，最多 100。" },
      search: { type: "string", description: "可選的 SKU、商品名稱、分類或儲位關鍵字。" },
      category: { type: "string", description: "可選的商品分類名稱。" },
    },
  },
  async execute(input, context) {
    const warehouse = await loadWarehouse(database(context));
    const page = boundedNumber(input, "page", 1, 10_000);
    const pageSize = boundedNumber(input, "pageSize", 50, 100);
    const search = textInput(input, "search").toLocaleLowerCase();
    const category = textInput(input, "category").toLocaleLowerCase();
    const zoneNames = new Map(warehouse.zones.map((zone) => [zone.id, `${zone.code} ${zone.name}`]));
    const filtered = warehouse.items.filter((item) => {
      const zone = item.zoneId ? zoneNames.get(item.zoneId) ?? "" : "";
      const matchesSearch = !search || [item.sku, item.name, item.category, zone]
        .some((value) => String(value ?? "").toLocaleLowerCase().includes(search));
      const matchesCategory = !category || item.category.toLocaleLowerCase() === category;
      return matchesSearch && matchesCategory;
    });
    const start = (page - 1) * pageSize;
    return json({
      page,
      pageSize,
      total: filtered.length,
      hasMore: start + pageSize < filtered.length,
      items: filtered.slice(start, start + pageSize),
    });
  },
};

type WarehouseMapObject = {
  id: string;
  sourceId: string;
  kind: "zone" | "label";
  name: string;
  code?: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type WarehouseData = Awaited<ReturnType<typeof loadWarehouse>>;

function warehouseMapObjects(warehouse: WarehouseData): WarehouseMapObject[] {
  return [
    ...warehouse.zones.map((zone) => ({
      id: `zone:${zone.id}`,
      sourceId: zone.id,
      kind: "zone" as const,
      name: zone.name,
      code: zone.code,
      color: zone.color,
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: zone.height,
    })),
    ...warehouse.layoutElements.map((element) => ({
      id: `label:${element.id}`,
      sourceId: element.id,
      kind: "label" as const,
      name: element.label,
      color: element.color,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    })),
  ];
}

function relativeDirection(target: WarehouseMapObject, other: WarehouseMapObject): string {
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const otherCenterX = other.x + other.width / 2;
  const otherCenterY = other.y + other.height / 2;
  const dx = otherCenterX - targetCenterX;
  const dy = otherCenterY - targetCenterY;
  const distance = Math.sqrt(dx ** 2 + dy ** 2);
  if (distance < 5) return "附近";

  const horizontal = dx >= 0 ? "右" : "左";
  const vertical = dy < 0 ? "上" : "下";
  if (Math.abs(dx) > Math.abs(dy) * 1.5) return `${horizontal}側`;
  if (Math.abs(dy) > Math.abs(dx) * 1.5) return `${vertical}方`;
  return `${horizontal}${vertical}方`;
}

function mapDistance(target: WarehouseMapObject, other: WarehouseMapObject): number {
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const otherCenterX = other.x + other.width / 2;
  const otherCenterY = other.y + other.height / 2;
  return Math.sqrt((otherCenterX - targetCenterX) ** 2 + (otherCenterY - targetCenterY) ** 2);
}

function mapObjectView(target: WarehouseMapObject, objects: WarehouseMapObject[]) {
  const nearby = objects
    .filter((object) => object.id !== target.id)
    .sort((left, right) => mapDistance(target, left) - mapDistance(target, right))
    .slice(0, 6)
    .map((object) => ({
      id: object.id,
      kind: object.kind,
      name: object.name,
      code: object.code,
      relation: relativeDirection(target, object),
      distancePercent: Math.round(mapDistance(target, object) * 10) / 10,
    }));

  return {
    id: target.id,
    sourceId: target.sourceId,
    kind: target.kind,
    name: target.name,
    code: target.code,
    color: target.color,
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    center: { x: target.x + target.width / 2, y: target.y + target.height / 2 },
    nearby,
  };
}

const wmsSearchWarehouseTool: PlatformToolDefinition = {
  key: WMS_SEARCH_WAREHOUSE_TOOL_KEY,
  label: "WMS 搜尋倉庫位置",
  description: "用一個查詢同時搜尋商品、倉位與地圖標籤；商品結果會附所在倉位，地圖結果會附附近物件的上下左右相對位置。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: [...wmsPermission, ...wmsMapPermission],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "商品名稱、SKU、倉位代碼/名稱或地圖標籤關鍵字。" },
      scope: { type: "string", description: "可選 inventory、map 或 all，預設 all。" },
      limit: { type: "string", description: "各類結果最多回傳幾筆，預設 20，最多 50。" },
    },
    required: ["query"],
  },
  async execute(input, context) {
    const query = textInput(input, "query");
    if (!query) throw new AssistantError("WMS 搜尋倉庫位置需要關鍵字。");
    if (query.length > 120) throw new AssistantError("WMS 搜尋關鍵字不能超過 120 字。");

    const warehouse = await loadWarehouse(database(context));
    const term = query.toLocaleLowerCase();
    const scopeInput = textInput(input, "scope").toLocaleLowerCase();
    const scope = scopeInput === "inventory" || scopeInput === "map" ? scopeInput : "all";
    const limit = boundedNumber(input, "limit", 20, 50);
    const objects = warehouseMapObjects(warehouse);
    const zonesById = new Map(objects.filter((object) => object.kind === "zone").map((object) => [object.sourceId, object]));
    const inventoryMatches = scope === "map" ? [] : warehouse.items.filter((item) => {
      const zone = item.zoneId ? zonesById.get(item.zoneId) : undefined;
      return [item.sku, item.name, item.category, item.notes, zone?.name, zone?.code]
        .some((value) => String(value ?? "").toLocaleLowerCase().includes(term));
    });
    const mapMatches = scope === "inventory" ? [] : objects.filter((object) => [object.name, object.code]
      .some((value) => String(value ?? "").toLocaleLowerCase().includes(term)));
    const matchedZoneIds = new Set(inventoryMatches.flatMap((item) => item.zoneId ? [item.zoneId] : []));
    const mapResultObjects = objects.filter((object) => mapMatches.some((match) => match.id === object.id) || matchedZoneIds.has(object.sourceId));

    return json({
      query,
      scope,
      inventoryTotal: inventoryMatches.length,
      mapTotal: mapResultObjects.length,
      inventoryItems: inventoryMatches.slice(0, limit).map((item) => ({
        ...item,
        location: item.zoneId && zonesById.has(item.zoneId)
          ? mapObjectView(zonesById.get(item.zoneId)!, objects)
          : null,
      })),
      mapObjects: mapResultObjects.slice(0, limit).map((object) => mapObjectView(object, objects)),
      canvas: warehouse.settings,
    });
  },
};

const wmsGetInventoryItemTool: PlatformToolDefinition = {
  key: WMS_GET_INVENTORY_ITEM_TOOL_KEY,
  label: "WMS 讀取庫存明細",
  description: "依 WMS 商品 ID 讀取單一庫存明細。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: wmsPermission,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "WMS inventory item ID。" },
    },
    required: ["id"],
  },
  async execute(input, context) {
    const id = textInput(input, "id");
    if (!id) throw new AssistantError("WMS 讀取庫存明細需要商品 ID。");
    const warehouse = await loadWarehouse(database(context));
    const item = warehouse.items.find((candidate) => candidate.id === id);
    return json(item ? { found: true, item } : { found: false, id });
  },
};

const wmsListLowStockTool: PlatformToolDefinition = {
  key: WMS_LIST_LOW_STOCK_TOOL_KEY,
  label: "WMS 查詢低庫存",
  description: "列出低於安全庫存或已無庫存的 WMS 商品。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: wmsPermission,
  parameters: {
    type: "object",
    properties: {
      includeZero: { type: "string", description: "是否包含庫存為 0 的商品，填 true 或 false，預設 true。" },
      limit: { type: "string", description: "最多回傳幾筆，預設 20，最多 50。" },
    },
  },
  async execute(input, context) {
    const warehouse = await loadWarehouse(database(context));
    const includeZero = textInput(input, "includeZero").toLowerCase() !== "false";
    const items = warehouse.items.filter((item) => {
      const isZero = item.quantity === 0;
      const isBelowMinimum = item.quantity > 0 && item.quantity <= item.minStock;
      return isBelowMinimum || (includeZero && isZero);
    });
    return json({
      includeZero,
      total: items.length,
      items: items.slice(0, boundedNumber(input, "limit", 20, 50)),
    });
  },
};

const wmsGetActivityTool: PlatformToolDefinition = {
  key: WMS_GET_ACTIVITY_TOOL_KEY,
  label: "WMS 查詢操作紀錄",
  description: "查詢 WMS 儲位、庫存、分類、地圖標示與倉庫設定的操作紀錄。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["wms:activity:read"],
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "操作紀錄、商品、儲位或操作者的關鍵字，可留空。" },
      entityType: { type: "string", description: "zone、inventory_item、product_category、layout_element 或 warehouse，可留空查全部。" },
      page: { type: "string", description: "頁碼，預設 1。" },
      pageSize: { type: "string", description: "每頁筆數，預設 20，最多 50。" },
    },
  },
  async execute(input, context) {
    const entityType = textInput(input, "entityType");
    const pageSize = boundedNumber(input, "pageSize", 20, 50);
    const result = await listActivity(database(context), {
      ...(WMS_ENTITY_TYPES.includes(entityType as (typeof WMS_ENTITY_TYPES)[number])
        ? { entityType: entityType as (typeof WMS_ENTITY_TYPES)[number] }
        : { entityTypes: WMS_ENTITY_TYPES }),
      source: "all",
      search: textInput(input, "search"),
      page: boundedNumber(input, "page", 1, 10_000),
      pageSize,
    });
    return json(result);
  },
};

export const PLATFORM_TOOL_DEFINITIONS: readonly PlatformToolDefinition[] = [
  platformOpenMeteoTool,
  wmsListInventoryTool,
  wmsSearchWarehouseTool,
  wmsGetInventoryItemTool,
  wmsListLowStockTool,
  wmsGetActivityTool,
];

export const PLATFORM_TOOL_KEYS = PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.key);
export const PLATFORM_TOOL_MAP = new Map(PLATFORM_TOOL_DEFINITIONS.map((tool) => [tool.key, tool]));

export function toolsForSurface(surface: ToolSurface): PlatformToolDefinition[] {
  return PLATFORM_TOOL_DEFINITIONS.filter((tool) => tool.surfaces.includes(surface)).slice();
}

export { OPEN_METEO_TOOL_KEY };
export type { ToolContract, ToolContext, ToolSurface } from "./contract.js";
