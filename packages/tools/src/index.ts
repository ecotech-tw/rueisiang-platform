import {
  AssistantError,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
} from "@rueisiang/assistant";
import {
  WMS_ENTITY_TYPES,
  findCustomer,
  listCustomerEvents,
  listCustomers,
  listTags,
  listActivity,
  loadWarehouse,
  normalizeCustomerQuery,
  readSyncStatus,
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

type CustomerToolRecord = {
  id: string;
  phone: string;
  name: string;
  email: string;
  address: string;
  sourceChannel: string;
  status: string;
  cyberbizCustomerId: string | null;
  cyberbizUid: string | null;
  cyberbizTagsJson: string;
  syncStatus: string;
  syncError: string | null;
  lastSyncedAt: string | null;
  lastWebhookAt: string | null;
  blockedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function customerToolView(customer: CustomerToolRecord) {
  return {
    id: customer.id,
    phone: customer.phone,
    name: customer.name,
    email: customer.email,
    address: customer.address,
    sourceChannel: customer.sourceChannel,
    status: customer.status,
    tags: parseStringArray(customer.cyberbizTagsJson),
    cyberbizCustomerId: customer.cyberbizCustomerId,
    cyberbizUid: customer.cyberbizUid,
    syncStatus: customer.syncStatus,
    syncError: customer.syncError,
    lastSyncedAt: customer.lastSyncedAt,
    lastWebhookAt: customer.lastWebhookAt,
    blockedAt: customer.blockedAt,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
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

export const CRM_SEARCH_CUSTOMERS_TOOL_KEY = "crm_search_customers";
export const CRM_GET_CUSTOMER_CONTEXT_TOOL_KEY = "crm_get_customer_context";
export const CRM_LIST_CUSTOMER_EVENTS_TOOL_KEY = "crm_list_customer_events";
export const CRM_LIST_CUSTOMER_TAGS_TOOL_KEY = "crm_list_customer_tags";
export const CRM_GET_SYNC_STATUS_TOOL_KEY = "crm_get_sync_status";

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

const crmSearchCustomersTool: PlatformToolDefinition = {
  key: CRM_SEARCH_CUSTOMERS_TOOL_KEY,
  label: "CRM 搜尋客戶",
  description: "搜尋與篩選 CRM 客戶資料，適合先找出客戶 ID，再取得單一客戶的完整背景。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:customer:read"],
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "姓名、電話、Email、地址或標籤關鍵字，可留空。" },
      channel: { type: "string", description: "客戶來源：all、manual 或 cyberbiz。預設 all。", enum: ["all", "manual", "cyberbiz"] },
      status: { type: "string", description: "客戶狀態：all、active 或 blocked。預設 all。", enum: ["all", "active", "blocked"] },
      tag: { type: "string", description: "指定標籤名稱，可留空。" },
      page: { type: "string", description: "頁碼，預設 1。" },
      pageSize: { type: "string", description: "每頁筆數，可用 10、25、50 或 100，預設 25。" },
      sortField: { type: "string", description: "排序欄位：name、phone、sourceChannel、status、createdAt 或 updatedAt。預設 updatedAt。" },
      sortDirection: { type: "string", description: "排序方向：asc 或 desc。預設 desc。", enum: ["asc", "desc"] },
    },
  },
  async execute(input, context) {
    const search = textInput(input, "search");
    if (search.length > 120) throw new AssistantError("CRM 客戶搜尋關鍵字不能超過 120 字。");

    const query = normalizeCustomerQuery({
      search,
      channel: textInput(input, "channel"),
      status: textInput(input, "status"),
      tag: textInput(input, "tag"),
      page: textInput(input, "page") || "1",
      pageSize: textInput(input, "pageSize") || "25",
      sortField: textInput(input, "sortField"),
      sortDirection: textInput(input, "sortDirection"),
    });
    const result = await listCustomers(database(context), query);
    return json({
      ...result,
      query,
      customers: result.customers.map((customer) => customerToolView(customer)),
    });
  },
};

const crmGetCustomerContextTool: PlatformToolDefinition = {
  key: CRM_GET_CUSTOMER_CONTEXT_TOOL_KEY,
  label: "CRM 取得客戶背景",
  description: "依客戶 ID 取得客戶資料、標籤、同步狀態與最近操作紀錄。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:customer:read", "crm:activity:read"],
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "CRM 客戶 ID，通常先由 crm_search_customers 取得。" },
      eventLimit: { type: "string", description: "最多回傳幾筆最近操作紀錄，預設 10，最多 25。" },
    },
    required: ["customerId"],
  },
  async execute(input, context) {
    const customerId = textInput(input, "customerId");
    if (!customerId) throw new AssistantError("CRM 取得客戶背景需要 customerId。");

    const db = database(context);
    const customer = await findCustomer(db, customerId);
    if (!customer) return json({ found: false, customerId });

    const events = await listCustomerEvents(db, {
      search: "",
      source: "all",
      customerId,
      page: 1,
      pageSize: boundedNumber(input, "eventLimit", 10, 25),
    });
    return json({
      found: true,
      customer: customerToolView(customer),
      events: events.events,
      eventsHasMore: events.hasMore,
    });
  },
};

const crmListCustomerEventsTool: PlatformToolDefinition = {
  key: CRM_LIST_CUSTOMER_EVENTS_TOOL_KEY,
  label: "CRM 查詢客戶操作紀錄",
  description: "查詢客戶新增、修改、同步與 webhook 等操作紀錄，可指定客戶或搜尋整體 CRM 紀錄。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:activity:read"],
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "指定客戶 ID，可留空查詢所有客戶。" },
      search: { type: "string", description: "事件摘要、事件類型、操作者或電話關鍵字，可留空。" },
      source: { type: "string", description: "紀錄來源：all、crm、cyberbiz_webhook 或 cyberbiz_sync。預設 all。", enum: ["all", "crm", "cyberbiz_webhook", "cyberbiz_sync"] },
      page: { type: "string", description: "頁碼，預設 1。" },
      pageSize: { type: "string", description: "每頁筆數，預設 25，最多 50。" },
    },
  },
  async execute(input, context) {
    const search = textInput(input, "search");
    if (search.length > 120) throw new AssistantError("CRM 操作紀錄搜尋關鍵字不能超過 120 字。");
    const sourceInput = textInput(input, "source");
    const source = ["crm", "cyberbiz_webhook", "cyberbiz_sync"].includes(sourceInput) ? sourceInput : "all";
    return json(await listCustomerEvents(database(context), {
      search,
      source,
      customerId: textInput(input, "customerId"),
      page: boundedNumber(input, "page", 1, 10_000),
      pageSize: boundedNumber(input, "pageSize", 25, 50),
    }));
  },
};

const crmListCustomerTagsTool: PlatformToolDefinition = {
  key: CRM_LIST_CUSTOMER_TAGS_TOOL_KEY,
  label: "CRM 列出客戶標籤",
  description: "列出 CRM 標籤字典與實際使用次數，協助模型理解可用的客戶分類。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:tag:read"],
  parameters: { type: "object", properties: {} },
  async execute(_input, context) {
    return json({ tags: await listTags(database(context)) });
  },
};

const crmGetSyncStatusTool: PlatformToolDefinition = {
  key: CRM_GET_SYNC_STATUS_TOOL_KEY,
  label: "CRM 查詢同步狀態",
  description: "查詢 CRM 客戶與 CYBERBIZ webhook 的同步統計及最近錯誤，不回傳原始 webhook payload。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:sync:read"],
  parameters: { type: "object", properties: {} },
  async execute(_input, context) {
    const status = await readSyncStatus(database(context));
    return json({
      ...status,
      recent: status.recent.map((event) => ({
        id: event.id,
        topic: event.topic,
        status: event.status,
        cyberbizCustomerId: event.cyberbizCustomerId,
        lastError: event.lastError,
        receivedAt: event.receivedAt,
      })),
    });
  },
};

export const PLATFORM_TOOL_DEFINITIONS: readonly PlatformToolDefinition[] = [
  platformOpenMeteoTool,
  wmsListInventoryTool,
  wmsSearchWarehouseTool,
  wmsGetInventoryItemTool,
  wmsListLowStockTool,
  wmsGetActivityTool,
  crmSearchCustomersTool,
  crmGetCustomerContextTool,
  crmListCustomerEventsTool,
  crmListCustomerTagsTool,
  crmGetSyncStatusTool,
];

export const PLATFORM_TOOL_KEYS = PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.key);
export const PLATFORM_TOOL_MAP = new Map(PLATFORM_TOOL_DEFINITIONS.map((tool) => [tool.key, tool]));

export function toolsForSurface(surface: ToolSurface): PlatformToolDefinition[] {
  return PLATFORM_TOOL_DEFINITIONS.filter((tool) => tool.surfaces.includes(surface)).slice();
}

export { OPEN_METEO_TOOL_KEY };
export type { ToolContract, ToolContext, ToolSurface } from "./contract.js";
