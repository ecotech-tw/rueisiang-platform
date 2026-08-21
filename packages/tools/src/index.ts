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

export const WMS_SEARCH_INVENTORY_TOOL_KEY = "wms_search_inventory";
export const WMS_LIST_INVENTORY_TOOL_KEY = "wms_list_inventory";
export const WMS_LIST_MAP_LABELS_TOOL_KEY = "wms_list_map_labels";
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

const wmsSearchInventoryTool: PlatformToolDefinition = {
  key: WMS_SEARCH_INVENTORY_TOOL_KEY,
  label: "WMS 搜尋庫存",
  description: "搜尋 WMS 商品庫存，可依 SKU、商品名稱、分類或儲位名稱查詢。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: wmsPermission,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "SKU、商品名稱、分類或儲位的關鍵字。" },
      limit: { type: "string", description: "最多回傳幾筆，預設 20，最多 50。" },
    },
    required: ["query"],
  },
  async execute(input, context) {
    const query = textInput(input, "query");
    if (!query) throw new AssistantError("WMS 搜尋庫存需要關鍵字。");
    if (query.length > 120) throw new AssistantError("WMS 搜尋關鍵字不能超過 120 字。");

    const warehouse = await loadWarehouse(database(context));
    const term = query.toLocaleLowerCase();
    const zoneNames = new Map(warehouse.zones.map((zone) => [zone.id, `${zone.code} ${zone.name}`]));
    const matches = warehouse.items.filter((item) => [
      item.sku,
      item.name,
      item.category,
      item.zoneId ? zoneNames.get(item.zoneId) : "",
      item.notes,
    ].some((value) => String(value ?? "").toLocaleLowerCase().includes(term)));

    return json({
      query,
      total: matches.length,
      items: matches.slice(0, boundedNumber(input, "limit", 20, 50)),
    });
  },
};

const wmsListMapLabelsTool: PlatformToolDefinition = {
  key: WMS_LIST_MAP_LABELS_TOOL_KEY,
  label: "WMS 地圖標籤",
  description: "列出 WMS 地圖上的標籤、顏色、座標與尺寸，可依標籤名稱搜尋。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: wmsMapPermission,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "可選的地圖標籤名稱關鍵字；留空時列出全部。" },
      limit: { type: "string", description: "最多回傳幾筆，預設 50，最多 100。" },
    },
  },
  async execute(input, context) {
    const warehouse = await loadWarehouse(database(context));
    const query = textInput(input, "query").toLocaleLowerCase();
    const filtered = warehouse.layoutElements
      .filter((element) => !query || element.label.toLocaleLowerCase().includes(query));
    const labels = filtered
      .slice(0, boundedNumber(input, "limit", 50, 100))
      .map(({ id, label, color, x, y, width, height }) => ({ id, label, color, x, y, width, height }));
    return json({
      query: textInput(input, "query"),
      total: filtered.length,
      canvas: warehouse.settings,
      labels,
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
  wmsSearchInventoryTool,
  wmsListMapLabelsTool,
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
