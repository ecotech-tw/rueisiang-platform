import {
  ASSISTANT_TIME_ZONE,
  AssistantError,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
} from "@rueisiang/assistant";
import {
  CyberbizApiError,
  createOrderClient,
  type CyberbizOrder,
  type CyberbizOrderListFilters,
} from "@rueisiang/cyberbiz";
import {
  WMS_ENTITY_TYPES,
  findCustomer,
  listCustomerEvents,
  customerStats,
  listCustomers,
  listTags,
  listActivity,
  loadWarehouse,
  normalizeCustomerQuery,
  canonicalReportStoreScopes,
  listReportScopes,
  type CyberbizPayoutQuery,
  type CyberbizSalesQuery,
  type ReportGroupBy,
  type Database,
  taipeiMidnightUtc,
  taipeiWallClockToUtc,
  listItems,
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
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function stringArrayInput(input: unknown, key: string): string[] {
  const value = objectInput(input)[key];
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.trim().startsWith("[")
        ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : value.split(",");
          } catch {
            return value.split(",");
          }
        })()
        : value.split(",")
      : [];
  return [...new Set(values.map((item) => String(item ?? "").trim()).filter(Boolean))];
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

function cyberbizReportToolResult(value: unknown, reportKind: "sales" | "payout", input: unknown): string {
  if (!value || typeof value !== "object") return json(value);
  const result = value as { status?: string };
  if (!["NO_DATA_FOR_RANGE", "UNSUPPORTED_GRANULARITY"].includes(result.status ?? "")) {
    return json(value);
  }
  const period = textInput(input, "period");
  const scopeType = textInput(input, "scopeType") || "company";
  const scopeId = textInput(input, "scopeId");
  const scopeName = textInput(input, "scopeName");
  const isShopee = scopeId.startsWith("shopee:") || /^(蝦皮|shopee)/iu.test(scopeName);
  const startDate = textInput(input, "startDate");
  const endDate = textInput(input, "endDate");
  const dateRange = {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
  if (result.status === "UNSUPPORTED_GRANULARITY") {
    return json({
      ...value,
      nextStep: {
        type: "unsupported_report_range",
        reportKind,
        period,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
        ...(scopeName ? { scopeName } : {}),
        ...dateRange,
        message: reportKind === "sales"
          ? "商品銷售只保存月資料，請改用 YYYY-MM 或完整月份的日期區間查詢。"
          : "目前的查詢日期區間不符合報表支援的粒度，請調整後重試。",
      },
    });
  }
  return json({
    ...value,
    nextStep: {
      type: "open_backend_report_runner",
      path: isShopee ? "/tools/shopee-sales" : reportKind === "sales" ? "/tools/cyberbiz-sales" : "/tools/payout",
      reportKind: isShopee ? "sales_and_payout" : reportKind,
      period,
      scopeType,
      ...(scopeId ? { scopeId } : {}),
      ...(scopeName ? { scopeName } : {}),
      ...dateRange,
      message: `請到後台執行對應的${isShopee ? "蝦皮" : "CYBERBIZ"}報表；原始 XLSX 會保留在 Google Drive，完成 D1 匯入後即可查詢。`,
    },
  });
}

function reportGroupByInput(input: unknown): ReportGroupBy[] | undefined {
  const value = textInput(input, "groupBy");
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean) as ReportGroupBy[];
}

interface CyberbizReportToolService {
  querySales(input: CyberbizSalesQuery): Promise<unknown>;
  queryPayout(input: CyberbizPayoutQuery): Promise<unknown>;
}

function cyberbizReportService(context: ToolContext | undefined): CyberbizReportToolService {
  const service = context?.services?.cyberbizReports;
  if (!service || typeof service !== "object" || typeof (service as CyberbizReportToolService).querySales !== "function") {
    throw new AssistantError("報表查詢服務目前不可用，請稍後再試。");
  }
  return service as CyberbizReportToolService;
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

function inputStringList(input: unknown, pluralKey: string, singularKey: string): string[] {
  const rawValues = [textInput(input, singularKey), textInput(input, pluralKey)].filter(Boolean);
  return [...new Set(rawValues.flatMap((value) => {
    const parsed = parseStringArray(value);
    return parsed.length ? parsed : value.split(",").map((item) => item.trim()).filter(Boolean);
  }))];
}

type CustomerToolRecord = {
  id: string;
  phone: string;
  name: string;
  email: string;
  address: string;
  status: string;
  tags: string[];
  cyberbizCustomerId: string | null;
  cyberbizUid: string | null;
  syncStatus: string;
  syncedAt: string | null;
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
    status: customer.status,
    tags: customer.tags,
    cyberbizCustomerId: customer.cyberbizCustomerId,
    cyberbizUid: customer.cyberbizUid,
    syncStatus: customer.syncStatus,
    syncedAt: customer.syncedAt,
    blockedAt: customer.blockedAt,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

function taipeiDayRange(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new AssistantError("CRM 日期請使用 YYYY-MM-DD 格式。");
  }
  try {
    const startWallClock = taipeiMidnightUtc(date);
    const nextDate = new Date(`${date}T00:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const endWallClock = taipeiMidnightUtc(nextDate.toISOString().slice(0, 10));
    const toIso = (wallClock: string) => new Date(`${wallClock.replace(" ", "T")}Z`).toISOString();
    return { from: toIso(startWallClock), to: toIso(endWallClock) };
  } catch {
    throw new AssistantError("CRM 日期格式無效。");
  }
}

const platformOpenMeteoTool: PlatformToolDefinition = {
  ...openMeteoTool,
  surfaces: ["sandbox", "line", "mcp"],
};

export const LIST_ITEMS_TOOL_KEY = "list_items";
export const WMS_LIST_INVENTORY_TOOL_KEY = "wms_list_inventory";
export const WMS_SEARCH_WAREHOUSE_TOOL_KEY = "wms_search_warehouse";
export const WMS_GET_INVENTORY_ITEM_TOOL_KEY = "wms_get_inventory_item";
export const WMS_LIST_LOW_STOCK_TOOL_KEY = "wms_list_low_stock_items";
export const WMS_GET_ACTIVITY_TOOL_KEY = "wms_get_activity";

export const CRM_SEARCH_CUSTOMERS_TOOL_KEY = "crm_search_customers";
export const CRM_GET_CUSTOMER_TOOL_KEY = "crm_get_customer";
export const CRM_GET_ORDERS_TOOL_KEY = "crm_get_orders";

const wmsPermission = ["wms:inventory:read"] as const;
const wmsMapPermission = ["wms:map:read"] as const;

const listItemsTool: PlatformToolDefinition = {
  key: LIST_ITEMS_TOOL_KEY,
  label: "查詢品項主檔",
  description: "用商品名稱、SKU 或分類搜尋平台品項主檔，回傳內部 itemId、SKU、品名、分類與是否有 WMS 庫存。查商品銷售、WMS 庫存或用料前，若使用者給的是自然語言商品名稱，先用這個工具解析 itemId；不要直接把自然語言商品名稱塞進 query_sales_report.productName。這個工具不是 WMS 清單，沒有倉儲紀錄的禮盒或銷售品項也會出現。只讀。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["items:item:read"],
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "商品名稱、SKU 或分類關鍵字；可留空列出最近同步的品項。多個關鍵字會同時符合，例如 醬釀黑豆 500ml。" },
      source: { type: "string", description: "可選來源：all、cyberbiz 或 custom。預設 all。", enum: ["all", "cyberbiz", "custom"] },
      kind: { type: "string", description: "可選品項類型：all、sellable 或 supply。查銷售通常用 sellable。預設 all。", enum: ["all", "sellable", "supply"] },
      active: { type: "string", description: "可選 true、false 或 all。預設 true，只列啟用中的品項。" },
      limit: { type: "string", description: "最多回傳幾筆，預設 20，最多 50。" },
    },
  },
  async execute(input, context) {
    const search = textInput(input, "search");
    if (search.length > 160) throw new AssistantError("品項搜尋關鍵字不能超過 160 字。");
    const source = textInput(input, "source").toLowerCase();
    const kind = textInput(input, "kind").toLowerCase();
    const active = textInput(input, "active").toLowerCase();
    const items = await listItems(database(context), {
      search,
      source: source === "cyberbiz" || source === "custom" ? source : "all",
      kind: kind === "sellable" || kind === "supply" ? kind : "all",
      active: active === "false" || active === "all" ? active : "true",
      limit: boundedNumber(input, "limit", 20, 50),
    });
    return json({ search, totalReturned: items.length, items });
  },
};

const wmsListInventoryTool: PlatformToolDefinition = {
  key: WMS_LIST_INVENTORY_TOOL_KEY,
  label: "WMS 列出商品庫存",
  description: "分頁列出 WMS 商品庫存，適合先取得商品清單，再依 SKU 或商品名稱做 mapping。只讀。",
  defaultStatus: "enabled",
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
  defaultStatus: "enabled",
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
  description: "依內部 itemId 讀取單一 WMS 庫存明細；itemId 可由 list_items 取得。只讀。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: wmsPermission,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "內部 itemId（也是 WMS inventory item ID）。" },
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
  defaultStatus: "enabled",
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
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["wms:activity:read"],
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "操作紀錄、商品、儲位或操作者的關鍵字，可留空。" },
      entityType: { type: "string", description: "wms_zone、item、wms_category、product_category、item_category、product_sku_mapping、cyberbiz_product_category、layout_element 或 warehouse，可留空查全部。" },
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
  description: "用關鍵字、條件篩選、排序與 limit 搜尋 CRM 客戶，適合先取得 customerId 或 cyberbizCustomerId，再交給 crm_get_customer 或 crm_get_orders。只讀。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:customer:read"],
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "姓名、電話、Email、地址或標籤關鍵字，可留空。" },
      status: { type: "string", description: "客戶狀態：all、active 或 blocked。預設 all。", enum: ["all", "active", "blocked"] },
      tag: { type: "string", description: "指定標籤名稱，可留空。" },
      date: { type: "string", description: "指定日期，使用 YYYY-MM-DD；例如今天要填入系統提供的 currentDate。可留空。" },
      dateField: { type: "string", description: "日期欄位：createdAt 查詢當天新增客戶，updatedAt 查詢當天更新客戶。預設 createdAt。", enum: ["createdAt", "updatedAt"] },
      page: { type: "string", description: "頁碼，預設 1。" },
      limit: { type: "string", description: "最多回傳幾位客戶，1 到 100，預設 25。" },
      sortField: { type: "string", description: "排序欄位：name、phone、status、createdAt 或 updatedAt。預設 updatedAt。" },
      sortDirection: { type: "string", description: "排序方向：asc 或 desc。預設 desc。", enum: ["asc", "desc"] },
    },
  },
  async execute(input, context) {
    const search = textInput(input, "search");
    if (search.length > 120) throw new AssistantError("CRM 客戶搜尋關鍵字不能超過 120 字。");
    const date = textInput(input, "date");
    const dateField = textInput(input, "dateField") === "updatedAt" ? "updatedAt" : "createdAt";
    const dateRange = date ? taipeiDayRange(date) : null;
    const rawLimit = textInput(input, "limit") || textInput(input, "pageSize");
    const parsedLimit = rawLimit ? Number(rawLimit) : 25;
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, Math.floor(parsedLimit))) : 25;
    const pageSize = limit <= 10 ? 10 : limit <= 25 ? 25 : limit <= 50 ? 50 : 100;

    const query = normalizeCustomerQuery({
      search,
      status: textInput(input, "status"),
      tag: textInput(input, "tag"),
      page: textInput(input, "page") || "1",
      pageSize: String(pageSize),
      sortField: textInput(input, "sortField"),
      sortDirection: textInput(input, "sortDirection"),
    });
    const db = database(context);
    // stats 描述整個資料庫，跟這次的篩選無關；它從列表查詢拆出去了，這裡要一起帶上，
    // 不然模型會少掉「總共幾位客戶、幾位停權」這種它拿來判斷範圍的背景資訊。
    const [result, stats] = await Promise.all([
      listCustomers(db, query, dateRange
        ? dateField === "updatedAt"
          ? { updatedFrom: dateRange.from, updatedTo: dateRange.to }
          : { createdFrom: dateRange.from, createdTo: dateRange.to }
        : {}),
      customerStats(db),
    ]);
    return json({
      ...result,
      stats,
      query,
      limit,
      dateFilter: dateRange ? { date, field: dateField, timeZone: ASSISTANT_TIME_ZONE } : null,
      customers: result.customers.slice(0, limit).map((customer) => customerToolView(customer)),
    });
  },
};

type CyberbizToolEnv = {
  CYBERBIZ_API_TOKEN?: string;
  CYBERBIZ_API_BASE_URL?: string;
};

type CustomerOrderSubject = {
  crmCustomerId: string | null;
  cyberbizCustomerId: string | null;
  name: string;
  phone: string;
  email: string;
};

type CustomerOrderIdentity = {
  subject: CustomerOrderSubject;
  customer: CustomerToolRecord | null;
};

type CustomerOrderLookup =
  | { kind: "not_found"; customerIds: string[] }
  | { kind: "unlinked"; subjects: CustomerOrderSubject[] }
  | {
    kind: "detail";
    orders: CyberbizOrder[];
    requestedOrderNumbers?: string[];
    notFoundOrderNumbers?: string[];
    notFoundOrderIds?: string[];
  }
  | {
    kind: "matched";
    subjects: CustomerOrderSubject[];
    orders: CyberbizOrder[];
    filters: CyberbizOrderListFilters;
    dateRange: { fromDate: string | null; toDate: string | null; timeZone: string };
    sortBy: CustomerOrderSortField;
    sortDirection: CustomerOrderSortDirection;
    hasMore: boolean;
    truncated: boolean;
    scannedPages: number;
  };

const MAX_CUSTOMER_ORDER_SCAN_PAGES = 20;
const MAX_ORDER_IDS_PER_REQUEST = 10;
const MAX_CUSTOMER_IDS_PER_REQUEST = 10;

type CustomerOrderSortField = "createdAt" | "updatedAt" | "totalPrice" | "orderNumber";
type CustomerOrderSortDirection = "asc" | "desc";

function normalizeOrderNumber(value: string): string {
  return value.trim().replace(/^#\s*/u, "");
}

function isNotFoundOrderError(error: unknown): boolean {
  return error instanceof CyberbizApiError && error.status === 404;
}

function cyberbizToolEnv(context: ToolContext | undefined): CyberbizToolEnv {
  const env = (context?.env ?? {}) as CyberbizToolEnv;
  if (!env.CYBERBIZ_API_TOKEN) {
    throw new AssistantError("尚未設定 CYBERBIZ_API_TOKEN，無法即時查詢 CYBERBIZ 消費紀錄。");
  }
  return env;
}

function cyberbizDateTime(date: string, endOfDay: boolean): string {
  taipeiDayRange(date);
  return `${date} ${endOfDay ? "23:59:59" : "00:00:00"}`;
}

function customerOrderSubject(customer: CustomerToolRecord | null, input: unknown): CustomerOrderSubject {
  return {
    crmCustomerId: customer?.id ?? (textInput(input, "customerId") || null),
    cyberbizCustomerId: textInput(input, "cyberbizCustomerId") || customer?.cyberbizCustomerId || null,
    name: customer?.name ?? "",
    phone: textInput(input, "phone") || customer?.phone || "",
    email: textInput(input, "email") || customer?.email || "",
  };
}

async function resolveCustomerOrderIdentities(
  input: unknown,
  context: ToolContext | undefined,
): Promise<{ identities: CustomerOrderIdentity[]; missingCustomerIds: string[] }> {
  const customerIds = inputStringList(input, "customerIds", "customerId").slice(0, MAX_CUSTOMER_IDS_PER_REQUEST);
  const cyberbizCustomerIds = inputStringList(input, "cyberbizCustomerIds", "cyberbizCustomerId").slice(0, MAX_CUSTOMER_IDS_PER_REQUEST);
  if (!customerIds.length && !cyberbizCustomerIds.length) {
    return { identities: [], missingCustomerIds: [] };
  }

  const identities: CustomerOrderIdentity[] = [];
  const missingCustomerIds: string[] = [];
  for (const customerId of customerIds) {
    const customer = await findCustomer(database(context), customerId);
    if (!customer) {
      missingCustomerIds.push(customerId);
      continue;
    }
    identities.push({ customer, subject: customerOrderSubject(customer, { customerId }) });
  }
  for (const cyberbizCustomerId of cyberbizCustomerIds) {
    if (identities.some((identity) => identity.subject.cyberbizCustomerId === cyberbizCustomerId)) continue;
    identities.push({
      customer: null,
      subject: customerOrderSubject(null, { cyberbizCustomerId }),
    });
  }
  return { identities, missingCustomerIds };
}

function parseCyberbizFilterDate(value: string): number | null {
  let normalized = value;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    try { normalized = `${taipeiWallClockToUtc(value).replace(" ", "T")}Z`; } catch { return null; }
  }
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function hasOrderFilters(filters: CyberbizOrderListFilters): boolean {
  return Boolean(
    filters.startTime ||
    filters.endTime ||
    filters.updatedAtStartTime ||
    filters.updatedAtEndTime ||
    filters.financialStatuses?.length ||
    filters.fulfillmentStatuses?.length ||
    filters.statuses?.length ||
    filters.returnStatuses?.length ||
    filters.tags?.length ||
    filters.excludedTags?.length ||
    filters.dataSource ||
    filters.vendor,
  );
}

function includesStatus(status: string, accepted: string[] | undefined): boolean {
  if (!accepted?.length) return true;
  const normalized = status.toLowerCase();
  return accepted.some((value) => value.toLowerCase() === normalized);
}

function orderMatchesFilters(order: CyberbizOrder, filters: CyberbizOrderListFilters): boolean {
  const matchesTimeRange = (value: string, start: string | undefined, end: string | undefined): boolean => {
    const timestamp = value ? Date.parse(value) : null;
    const startTime = start ? parseCyberbizFilterDate(start) : null;
    const endTime = end ? parseCyberbizFilterDate(end) : null;
    if (startTime !== null && (timestamp === null || timestamp < startTime)) return false;
    if (endTime !== null && (timestamp === null || timestamp > endTime)) return false;
    return true;
  };

  if (!matchesTimeRange(order.createdAt, filters.startTime, filters.endTime)) return false;
  if (!matchesTimeRange(order.updatedAt, filters.updatedAtStartTime, filters.updatedAtEndTime)) return false;
  if (!includesStatus(order.statuses.financialStatus, filters.financialStatuses)) return false;
  if (!includesStatus(order.statuses.fulfillmentStatus, filters.fulfillmentStatuses)) return false;
  if (!includesStatus(order.statuses.orderStatus, filters.statuses)) return false;
  if (!includesStatus(order.statuses.returnStatus, filters.returnStatuses)) return false;
  return true;
}

function orderQueryFilters(input: unknown): {
  filters: CyberbizOrderListFilters;
  dateRange: { fromDate: string | null; toDate: string | null; timeZone: string };
} {
  const fromDate = textInput(input, "fromDate") || null;
  const toDate = textInput(input, "toDate") || null;
  const updatedFromDate = textInput(input, "updatedFromDate") || null;
  const updatedToDate = textInput(input, "updatedToDate") || null;
  if ((fromDate && toDate && fromDate > toDate) || (updatedFromDate && updatedToDate && updatedFromDate > updatedToDate)) {
    throw new AssistantError("CRM 訂單日期範圍的起始日不能晚於結束日。");
  }

  const orderStatuses = inputStringList(input, "orderStatuses", "orderStatus");
  const financialStatuses = inputStringList(input, "financialStatuses", "financialStatus");
  const fulfillmentStatuses = inputStringList(input, "fulfillmentStatuses", "fulfillmentStatus");
  const returnStatuses = inputStringList(input, "returnStatuses", "returnStatus");
  const tags = inputStringList(input, "tags", "tag");
  const excludedTags = inputStringList(input, "excludedTags", "excludedTag");
  return {
    filters: {
      ...(fromDate ? { startTime: cyberbizDateTime(fromDate, false) } : {}),
      ...(toDate ? { endTime: cyberbizDateTime(toDate, true) } : {}),
      ...(updatedFromDate ? { updatedAtStartTime: cyberbizDateTime(updatedFromDate, false) } : {}),
      ...(updatedToDate ? { updatedAtEndTime: cyberbizDateTime(updatedToDate, true) } : {}),
      ...(orderStatuses.length ? { statuses: orderStatuses } : {}),
      ...(financialStatuses.length ? { financialStatuses } : {}),
      ...(fulfillmentStatuses.length ? { fulfillmentStatuses } : {}),
      ...(returnStatuses.length ? { returnStatuses } : {}),
      ...(tags.length ? { tags } : {}),
      ...(excludedTags.length ? { excludedTags } : {}),
    },
    dateRange: { fromDate: fromDate ?? updatedFromDate, toDate: toDate ?? updatedToDate, timeZone: ASSISTANT_TIME_ZONE },
  };
}

function customerOrderSort(input: unknown): { sortBy: CustomerOrderSortField; sortDirection: CustomerOrderSortDirection } {
  const sortByInput = textInput(input, "sortBy");
  const sortBy: CustomerOrderSortField = ["updatedAt", "totalPrice", "orderNumber"].includes(sortByInput)
    ? sortByInput as CustomerOrderSortField
    : "createdAt";
  return {
    sortBy,
    sortDirection: textInput(input, "sortDirection") === "asc" ? "asc" : "desc",
  };
}

function sortCustomerOrders(
  orders: CyberbizOrder[],
  sortBy: CustomerOrderSortField,
  sortDirection: CustomerOrderSortDirection,
): CyberbizOrder[] {
  const multiplier = sortDirection === "asc" ? 1 : -1;
  return orders.slice().sort((left, right) => {
    if (sortBy === "totalPrice") {
      // 沒有金額的訂單一律墊底，不隨 sortDirection 翻面：舊寫法把 null 當 -Infinity，
      // 兩筆都是 null 時相減會得到 NaN，Array.sort 拿到 NaN 的排序結果是未定義的。
      const leftPrice = left.totalPrice;
      const rightPrice = right.totalPrice;
      if (leftPrice === null && rightPrice === null) return 0;
      if (leftPrice === null) return 1;
      if (rightPrice === null) return -1;
      return (leftPrice - rightPrice) * multiplier;
    }
    const leftValue = sortBy === "updatedAt"
      ? left.updatedAt
      : sortBy === "orderNumber"
        ? left.orderNumber
        : left.createdAt;
    const rightValue = sortBy === "updatedAt"
      ? right.updatedAt
      : sortBy === "orderNumber"
        ? right.orderNumber
        : right.createdAt;
    return leftValue.localeCompare(rightValue) * multiplier;
  });
}

async function lookupCustomerOrders(
  input: unknown,
  context: ToolContext | undefined,
  defaultLimit = 10,
  maxLimit = 50,
): Promise<CustomerOrderLookup> {
  const env = cyberbizToolEnv(context);
  const client = createOrderClient({ apiToken: env.CYBERBIZ_API_TOKEN!, baseUrl: env.CYBERBIZ_API_BASE_URL });
  const requestedLimit = Math.min(maxLimit, boundedNumber(input, "limit", defaultLimit, maxLimit));
  const { sortBy, sortDirection } = customerOrderSort(input);
  const rawOrderIds = inputStringList(input, "orderIds", "orderId");
  const orderNumbers = [
    ...inputStringList(input, "orderNumbers", "orderNumber"),
    ...rawOrderIds.filter((value) => /^#\s*/u.test(value)).map(normalizeOrderNumber),
  ].map(normalizeOrderNumber).filter(Boolean).slice(0, MAX_ORDER_IDS_PER_REQUEST);
  const orderIds = rawOrderIds
    .filter((value) => !/^#\s*/u.test(value))
    .slice(0, MAX_ORDER_IDS_PER_REQUEST);
  const suppliedCustomerIds = inputStringList(input, "customerIds", "customerId");
  const suppliedCyberbizCustomerIds = inputStringList(input, "cyberbizCustomerIds", "cyberbizCustomerId");
  const hasCustomerFilter = suppliedCustomerIds.length > 0 || suppliedCyberbizCustomerIds.length > 0;
  const resolved = await resolveCustomerOrderIdentities(input, context);
  const linkedCustomerIds = new Set(
    resolved.identities
      .map((identity) => identity.subject.cyberbizCustomerId)
      .filter((id): id is string => Boolean(id)),
  );

  if (hasCustomerFilter && !resolved.identities.length) {
    return { kind: "not_found", customerIds: resolved.missingCustomerIds.length ? resolved.missingCustomerIds : suppliedCustomerIds };
  }
  if (hasCustomerFilter && !linkedCustomerIds.size) {
    return { kind: "unlinked", subjects: resolved.identities.map((identity) => identity.subject) };
  }

  if (orderIds.length || orderNumbers.length) {
    const mappings = orderNumbers.length ? await client.fetchIdsByOrderNumbers(orderNumbers) : [];
    const mappingByNumber = new Map(mappings.map((mapping) => [normalizeOrderNumber(mapping.orderNumber), mapping]));
    const resolvedOrderNumberById = new Map<string, string>();
    const resolvedOrderNumbers = orderNumbers.flatMap((orderNumber) => {
      const mapping = mappingByNumber.get(orderNumber);
      if (mapping) resolvedOrderNumberById.set(mapping.orderId, orderNumber);
      return mapping ? [mapping.orderId] : [];
    });
    const missingOrderNumbers = orderNumbers.filter((orderNumber) => !mappingByNumber.has(orderNumber));
    const details: CyberbizOrder[] = [];
    const notFoundOrderIds: string[] = [];
    const notFoundOrderNumbers = [...missingOrderNumbers];
    const idsToFetch = [...new Set([...orderIds, ...resolvedOrderNumbers])].slice(0, MAX_ORDER_IDS_PER_REQUEST);
    for (const orderId of idsToFetch) {
      try {
        details.push(await client.fetchOne(orderId));
      } catch (error) {
        // The model may mistake a human-facing order number for the internal ID.  A
        // 404 is safe to resolve through the official mapping endpoint; other API
        // failures must remain visible to the caller.
        if (!isNotFoundOrderError(error)) throw error;
        const fallback = await client.fetchIdsByOrderNumbers([orderId]);
        const fallbackId = fallback[0]?.orderId;
        if (!fallbackId) {
          const originalOrderNumber = resolvedOrderNumberById.get(orderId);
          if (originalOrderNumber) {
            notFoundOrderNumbers.push(originalOrderNumber);
          } else {
            notFoundOrderIds.push(orderId);
          }
          continue;
        }
        details.push(await client.fetchOne(fallbackId));
      }
    }
    const filtered = hasCustomerFilter
      ? details.filter((order) => linkedCustomerIds.has(order.customer.id))
      : details;
    return {
      kind: "detail",
      orders: sortCustomerOrders(filtered, sortBy, sortDirection).slice(0, requestedLimit),
      ...(orderNumbers.length ? {
        requestedOrderNumbers: orderNumbers,
        ...(notFoundOrderNumbers.length ? { notFoundOrderNumbers: [...new Set(notFoundOrderNumbers)] } : {}),
      } : {}),
      ...(notFoundOrderIds.length ? { notFoundOrderIds } : {}),
    };
  }

  const { filters, dateRange } = orderQueryFilters(input);
  const orders: CyberbizOrder[] = [];
  let scannedPages = 0;
  let hasMore = false;
  const needsFullScan = sortBy !== "createdAt" || sortDirection !== "desc";
  const useGlobalSearch = hasOrderFilters(filters) || !linkedCustomerIds.size;
  const globalPerPage = hasOrderFilters(filters) || needsFullScan ? 50 : requestedLimit;

  if (useGlobalSearch) {
    for (let page = 1; page <= MAX_CUSTOMER_ORDER_SCAN_PAGES; page += 1) {
      const result = await client.fetchPage({
        ...filters,
        page,
        perPage: globalPerPage,
        offset: (page - 1) * globalPerPage,
      });
      scannedPages += 1;
      for (const order of result.orders) {
        const belongsToCustomer = !linkedCustomerIds.size || linkedCustomerIds.has(order.customer.id);
        if (belongsToCustomer && orderMatchesFilters(order, filters)) orders.push(order);
      }
      hasMore = result.hasMore;
      if ((!needsFullScan && orders.length >= requestedLimit) || !result.hasMore || result.orders.length === 0) break;
    }
  } else {
    for (const cyberbizCustomerId of linkedCustomerIds) {
      if (scannedPages >= MAX_CUSTOMER_ORDER_SCAN_PAGES) break;
      const perPage = Math.min(50, requestedLimit);
      let customerPage = 1;
      let customerOrderCount = 0;
      while (customerPage <= MAX_CUSTOMER_ORDER_SCAN_PAGES
        && scannedPages < MAX_CUSTOMER_ORDER_SCAN_PAGES
        && (needsFullScan || customerOrderCount < requestedLimit)) {
        const result = await client.fetchCustomerOrders(cyberbizCustomerId, {
          page: customerPage,
          perPage,
          offset: (customerPage - 1) * perPage,
        });
        scannedPages += 1;
        customerOrderCount += result.orders.length;
        orders.push(...result.orders.filter((order) => orderMatchesFilters(order, filters)));
        hasMore = hasMore || result.hasMore;
        if (!result.hasMore || result.orders.length === 0) break;
        customerPage += 1;
      }
    }
  }

  return {
    kind: "matched",
    subjects: resolved.identities.map((identity) => identity.subject),
    orders: sortCustomerOrders(orders, sortBy, sortDirection).slice(0, requestedLimit),
    filters,
    dateRange,
    sortBy,
    sortDirection,
    hasMore,
    truncated: hasMore && scannedPages >= MAX_CUSTOMER_ORDER_SCAN_PAGES,
    scannedPages,
  };
}

function orderToolResult(lookup: CustomerOrderLookup): string {
  if (lookup.kind === "not_found") return json({ found: false, customerIds: lookup.customerIds });
  if (lookup.kind === "detail") {
    return json({
      source: "cyberbiz_live",
      mode: "detail",
      retrievedAt: new Date().toISOString(),
      totalReturned: lookup.orders.length,
      ...(lookup.requestedOrderNumbers ? { requestedOrderNumbers: lookup.requestedOrderNumbers } : {}),
      ...(lookup.notFoundOrderNumbers?.length ? { notFoundOrderNumbers: lookup.notFoundOrderNumbers } : {}),
      ...(lookup.notFoundOrderIds?.length ? { notFoundOrderIds: lookup.notFoundOrderIds } : {}),
      orders: lookup.orders,
    });
  }
  if (lookup.kind === "unlinked") {
    return json({
      found: true,
      linked: false,
      customers: lookup.subjects,
      message: "CRM 客戶尚未有可用的 CYBERBIZ customer id，無法查詢即時訂單。",
    });
  }
  return json({
    source: "cyberbiz_live",
    customers: lookup.subjects,
    dateRange: lookup.dateRange,
    filters: lookup.filters,
    sort: { by: lookup.sortBy, direction: lookup.sortDirection },
    totalReturned: lookup.orders.length,
    hasMore: lookup.hasMore,
    truncated: lookup.truncated,
    scannedPages: lookup.scannedPages,
    retrievedAt: new Date().toISOString(),
    orders: lookup.orders,
  });
}

function customerDetailsInclude(input: unknown): { events: boolean; tags: boolean; spending: boolean } {
  const raw = textInput(input, "include").toLocaleLowerCase();
  if (!raw) return { events: true, tags: true, spending: false };
  const values = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  if (values.has("all")) return { events: true, tags: true, spending: true };
  return {
    events: values.has("events") || values.has("activity") || values.has("context"),
    tags: values.has("tags"),
    spending: values.has("spending") || values.has("summary"),
  };
}

type MatchedCustomerOrders = Extract<CustomerOrderLookup, { kind: "matched" }>;

function customerSpendingSummary(lookup: MatchedCustomerOrders) {
  const amounts = lookup.orders
    .map((order) => order.totalPrice)
    .filter((value): value is number => value !== null);
  const totalSpent = Math.round(amounts.reduce((total, amount) => total + amount, 0) * 100) / 100;
  const productMap = new Map<string, { name: string; sku: string; quantity: number; spent: number }>();
  for (const order of lookup.orders) {
    for (const item of order.lineItems) {
      const key = item.sku + "|" + item.title + "|" + item.variantTitle;
      const current = productMap.get(key) ?? {
        name: [item.title, item.variantTitle].filter(Boolean).join(" / "),
        sku: item.sku,
        quantity: 0,
        spent: 0,
      };
      current.quantity += item.quantity;
      current.spent += item.totalPriceAfterDiscounts ?? (item.price === null ? 0 : item.price * item.quantity);
      productMap.set(key, current);
    }
  }
  const topProducts = [...productMap.values()]
    .sort((left, right) => right.quantity - left.quantity || right.spent - left.spent)
    .slice(0, 10)
    .map((product) => ({ ...product, spent: Math.round(product.spent * 100) / 100 }));
  const lastOrderAt = lookup.orders
    .map((order) => order.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const refundedOrderCount = lookup.orders.filter((order) =>
    ["refunded", "partial_refunded", "pending_refund"].includes(order.statuses.financialStatus) ||
    ["returned", "partial_return"].includes(order.statuses.returnStatus),
  ).length;

  return {
    source: "cyberbiz_live",
    customers: lookup.subjects,
    dateRange: lookup.dateRange,
    filters: lookup.filters,
    sort: { by: lookup.sortBy, direction: lookup.sortDirection },
    orderCount: lookup.orders.length,
    totalSpent,
    currency: "TWD",
    averageOrderValue: lookup.orders.length ? Math.round((totalSpent / lookup.orders.length) * 100) / 100 : 0,
    lastOrderAt,
    refundedOrderCount,
    topProducts,
    complete: !lookup.hasMore && !lookup.truncated,
    hasMore: lookup.hasMore,
    truncated: lookup.truncated,
    scannedPages: lookup.scannedPages,
    retrievedAt: new Date().toISOString(),
  };
}

const crmGetCustomerTool: PlatformToolDefinition = {
  key: CRM_GET_CUSTOMER_TOOL_KEY,
  label: "CRM 取得客戶",
  description: "依 customerId 取得單一客戶完整資料，包含客戶標籤、可選的最近操作紀錄；需要消費金額或購買摘要時可在 include 填 spending。只讀。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:customer:read", "crm:activity:read", "crm:tag:read", "crm:order:read"],
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "CRM 客戶 ID，通常先由 crm_search_customers 取得。" },
      include: { type: "string", description: "可選資料區塊，以逗號分隔：events、tags、spending 或 all。預設 events,tags；spending 會即時查詢 CYBERBIZ，可能較慢。" },
      eventLimit: { type: "string", description: "最多回傳幾筆最近操作紀錄，預設 10，最多 25。" },
      spendingLimit: { type: "string", description: "計算消費摘要時最多查幾筆訂單，預設 100，最多 100。" },
      fromDate: { type: "string", description: "消費摘要的訂單建立起始日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      toDate: { type: "string", description: "消費摘要的訂單建立結束日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      financialStatus: { type: "string", description: "消費摘要的付款狀態，例如 paid、cod、refunded；可留空。" },
      fulfillmentStatus: { type: "string", description: "消費摘要的配送狀態，例如 unshipped、fulfilled、received；可留空。" },
    },
    required: ["customerId"],
  },
  async execute(input, context) {
    const customerId = textInput(input, "customerId");
    if (!customerId) throw new AssistantError("CRM 取得客戶需要 customerId。");

    const db = database(context);
    const customer = await findCustomer(db, customerId);
    if (!customer) return json({ found: false, customerId });

    const include = customerDetailsInclude(input);
    const view = customerToolView(customer);
    const result: Record<string, unknown> = {
      found: true,
      customer: view,
      tags: view.tags,
    };

    if (include.tags) {
      result.tagCatalog = await listTags(db);
    }
    if (include.events) {
      const events = await listCustomerEvents(db, {
        search: "",
        source: "all",
        customerId,
        page: 1,
        pageSize: boundedNumber(input, "eventLimit", 10, 25),
      });
      result.events = events.events;
      result.eventsHasMore = events.hasMore;
    }
    if (include.spending) {
      const lookup = await lookupCustomerOrders({
        ...objectInput(input),
        customerId,
        limit: textInput(input, "spendingLimit") || "100",
      }, context, 100, 100);
      result.spendingSummary = lookup.kind === "matched"
        ? customerSpendingSummary(lookup)
        : { available: false, details: JSON.parse(orderToolResult(lookup)) };
    }

    return json(result);
  },
};

const crmGetOrdersTool: PlatformToolDefinition = {
  key: CRM_GET_ORDERS_TOOL_KEY,
  label: "CRM 查詢訂單",
  description: "查詢 CYBERBIZ 即時訂單。可用 customerId(s) 或 cyberbizCustomerId(s) 查客戶訂單；使用 orderNumber(s) 查使用者看得到的訂單編號（例如 #56714），系統會先轉成 CYBERBIZ order ID 再取得明細；只有已知 CYBERBIZ 內部 ID 時才使用 orderId(s)。沒有客戶 ID 時也可用日期、狀態、標籤、排序與 limit 搜尋訂單。只讀。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["crm:order:read"],
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "單一 CRM 客戶 ID，通常先由 crm_search_customers 取得。" },
      customerIds: { type: "string", description: "多個 CRM 客戶 ID，以逗號分隔；最多 10 個。" },
      cyberbizCustomerId: { type: "string", description: "單一 CYBERBIZ customer ID，可直接查詢。" },
      cyberbizCustomerIds: { type: "string", description: "多個 CYBERBIZ customer ID，以逗號分隔；最多 10 個。" },
      orderNumber: { type: "string", description: "使用者看得到的單一訂單編號，例如 #56714；不要把它當成 orderId。" },
      orderNumbers: { type: "string", description: "多個使用者看得到的訂單編號，以逗號分隔，例如 #56714,#56715；最多 10 個。" },
      orderId: { type: "string", description: "單一 CYBERBIZ 內部 order ID；只有已知 API ID 時使用，不是使用者看到的訂單編號。" },
      orderIds: { type: "string", description: "多個 CYBERBIZ 內部 order ID，以逗號分隔；最多 10 個。" },
      fromDate: { type: "string", description: "訂單建立起始日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      toDate: { type: "string", description: "訂單建立結束日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      updatedFromDate: { type: "string", description: "訂單更新起始日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      updatedToDate: { type: "string", description: "訂單更新結束日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      orderStatus: { type: "string", description: "訂單狀態，例如 open、closed、cancelled；可留空。" },
      orderStatuses: { type: "string", description: "多個訂單狀態，以逗號分隔；可留空。" },
      financialStatus: { type: "string", description: "付款狀態，例如 paid、cod、refunded；可留空。" },
      financialStatuses: { type: "string", description: "多個付款狀態，以逗號分隔；可留空。" },
      fulfillmentStatus: { type: "string", description: "配送狀態，例如 unshipped、fulfilled、received；可留空。" },
      fulfillmentStatuses: { type: "string", description: "多個配送狀態，以逗號分隔；可留空。" },
      returnStatus: { type: "string", description: "退貨狀態；可留空。" },
      returnStatuses: { type: "string", description: "多個退貨狀態，以逗號分隔；可留空。" },
      tag: { type: "string", description: "CYBERBIZ 訂單標籤；可留空。" },
      tags: { type: "string", description: "多個 CYBERBIZ 訂單標籤，以逗號分隔；可留空。" },
      excludedTag: { type: "string", description: "要排除的 CYBERBIZ 訂單標籤；可留空。" },
      excludedTags: { type: "string", description: "多個要排除的 CYBERBIZ 訂單標籤，以逗號分隔；可留空。" },
      sortBy: { type: "string", description: "排序欄位：createdAt、updatedAt、totalPrice 或 orderNumber。預設 createdAt。", enum: ["createdAt", "updatedAt", "totalPrice", "orderNumber"] },
      sortDirection: { type: "string", description: "排序方向：asc 或 desc。預設 desc。", enum: ["asc", "desc"] },
      limit: { type: "string", description: "最多回傳幾筆訂單，預設 10，最多 50。" },
    },
  },
  async execute(input, context) {
    return orderToolResult(await lookupCustomerOrders(input, context, 10, 50));
  },
};

export const LIST_REPORT_SCOPES_TOOL_KEY = "list_report_scopes";

const listReportScopesTool: PlatformToolDefinition = {
  key: LIST_REPORT_SCOPES_TOOL_KEY,
  label: "列出報表據點",
  description: "列出目前可供報表查詢的啟用據點正式名稱與 scopeId。當使用者用簡稱或不確定店名時，先呼叫這個工具，再把回傳的 scopeName 原樣傳給 query_payout_report 或 query_sales_report；不要自行猜測店名。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["reports:cyberbiz:read"],
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_input, context) {
    const scopes = canonicalReportStoreScopes(await listReportScopes(database(context), "store"));
    return json({
      status: "ok",
      scopeType: "store",
      scopes: scopes.map((scope) => ({ scopeId: scope.id, scopeName: scope.name })),
    });
  },
};

const cyberbizQuerySalesReportTool: PlatformToolDefinition = {
  key: "query_sales_report",
  label: "查詢商品銷售報表",
  description: "從已匯入 D1 的通路商品銷售月資料查詢單一商品、分類、單一櫃位或公司整體的銷售數與售額。查特定商品時優先傳 list_items 回傳的 itemIds；通路的 SKU 或蝦皮 Product ID 仍可用 sku 相容查詢。productName 只是舊版關鍵字模糊搜尋 fallback，不適合拿自然語言商品名稱直接查。這不是 CRM 訂單查詢；單一 scope 請傳 scopeName（例如誠品西門店3F或蝦皮），不需要使用者知道 scopeId。蝦皮目前以 scopeName=蝦皮代表整個蝦皮賣場，請使用 scopeType=store。支援月份與年份；自訂日期只能使用完整月份，否則會回傳 UNSUPPORTED_GRANULARITY。公司查詢由服務端完成所有據點的彙總，不需要逐店呼叫工具。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["reports:cyberbiz:read"],
  parameters: {
    type: "object",
    properties: {
      period: { type: "string", description: "報表期間，YYYY 代表全年、YYYY-MM 代表整月；也可改用 startDate 與 endDate。" },
      scopeType: { type: "string", description: "查詢範圍：company 為公司整體；store 為單一櫃位。", enum: ["company", "store"] },
      scopeName: { type: "string", description: "scopeType=store 時的 scope 名稱，例如 誠品西門店3F 或 蝦皮；由服務端解析固定 scopeId。" },
      scopeId: { type: "string", description: "相容既有呼叫的櫃位固定 ID；通常不需要填，優先使用 scopeName。" },
      startDate: { type: "string", description: "自訂完整月份起始日 YYYY-MM-01，需與 endDate 一起提供。" },
      endDate: { type: "string", description: "自訂完整月份結束日 YYYY-MM-DD，需與 startDate 一起提供。" },
      groupBy: { type: "string", description: "可選分組，使用逗號分隔：month、scope、sku、category；例如月銷量使用 month,sku。" },
      itemIds: { type: "string", description: "可選內部 itemId 清單；使用逗號分隔或 JSON array 字串。查特定商品時優先使用 list_items 回傳的 itemId。" },
      sku: { type: "string", description: "可選系統 SKU，精確查詢單一商品；服務端也兼容通路 SKU 或蝦皮 Product ID。" },
      category: { type: "string", description: "可選商品分類，回傳該分類商品合計。" },
      productName: { type: "string", description: "可選商品名稱關鍵字。" },
    },
    required: ["scopeType"],
  },
  async execute(input, context) {
    const period = textInput(input, "period");
    const scopeType = textInput(input, "scopeType");
    const startDate = textInput(input, "startDate");
    const endDate = textInput(input, "endDate");
    if ((!period && (!startDate || !endDate)) || (startDate && !endDate) || (!startDate && endDate) || !["company", "store"].includes(scopeType)) {
      throw new AssistantError("商品銷售報表查詢需要正確的 period 或完整日期區間，以及 scopeType。");
    }
    const scopeId = textInput(input, "scopeId");
    const scopeName = textInput(input, "scopeName");
    if (scopeType === "store" && !scopeId && !scopeName) throw new AssistantError("查詢單一櫃位時需要店面名稱。");
    return cyberbizReportToolResult(await cyberbizReportService(context).querySales({
      ...(period ? { period } : {}),
      scopeType: scopeType as CyberbizSalesQuery["scopeType"],
      ...(scopeId ? { scopeId } : {}),
      ...(scopeName ? { scopeName } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(reportGroupByInput(input) ? { groupBy: reportGroupByInput(input) } : {}),
      ...(stringArrayInput(input, "itemIds").length ? { itemIds: stringArrayInput(input, "itemIds") } : {}),
      ...(textInput(input, "sku") ? { sku: textInput(input, "sku") } : {}),
      ...(textInput(input, "category") ? { category: textInput(input, "category") } : {}),
      ...(textInput(input, "productName") ? { productName: textInput(input, "productName") } : {}),
    }), "sales", input);
  },
};

const cyberbizQueryPayoutReportTool: PlatformToolDefinition = {
  key: "query_payout_report",
  label: "查詢業績／出金報表",
  description: "從已解析的通路每日 payout／出金資料查詢單一 scope 或公司整體的業績合計與明細；公司內部使用者說「業績」時，以這裡的 payoutAmount 回答。這不是商品銷售報表，也不是 CRM 訂單查詢；商品數量、SKU、分類或商品銷售額請使用 query_sales_report。單一 scope 請傳 scopeName（例如誠品西門店3F或蝦皮），不需要使用者知道 scopeId。蝦皮目前以 scopeName=蝦皮代表整個蝦皮賣場，請使用 scopeType=store。服務端會先檢查指定區間是否完整涵蓋，再一次完成查詢。",
  defaultStatus: "enabled",
  surfaces: ["sandbox", "line", "mcp"],
  requiredPermissions: ["reports:cyberbiz:read"],
  parameters: {
    type: "object",
    properties: {
      period: { type: "string", description: "報表期間，YYYY 代表全年、YYYY-MM 代表整月；也可改用 startDate 與 endDate。" },
      scopeType: { type: "string", description: "查詢範圍：company 為公司整體；store 為單一櫃位。", enum: ["company", "store"] },
      scopeName: { type: "string", description: "scopeType=store 時的 scope 名稱，例如 誠品西門店3F 或 蝦皮；由服務端解析固定 scopeId。" },
      scopeId: { type: "string", description: "相容既有呼叫的櫃位固定 ID；通常不需要填，優先使用 scopeName。" },
      startDate: { type: "string", description: "自訂區間起始日 YYYY-MM-DD，需與 endDate 一起提供。" },
      endDate: { type: "string", description: "自訂區間結束日 YYYY-MM-DD，需與 startDate 一起提供。" },
      groupBy: { type: "string", description: "可選分組，使用逗號分隔：day、month、scope；例如 scope,month。" },
    },
    required: ["scopeType"],
  },
  async execute(input, context) {
    const period = textInput(input, "period");
    const scopeType = textInput(input, "scopeType");
    const startDate = textInput(input, "startDate");
    const endDate = textInput(input, "endDate");
    if ((!period && (!startDate || !endDate)) || (startDate && !endDate) || (!startDate && endDate) || !["company", "store"].includes(scopeType)) {
      throw new AssistantError("出金報表查詢需要正確的 period 或完整日期區間，以及 scopeType。");
    }
    const scopeId = textInput(input, "scopeId");
    const scopeName = textInput(input, "scopeName");
    if (scopeType === "store" && !scopeId && !scopeName) throw new AssistantError("查詢單一櫃位時需要店面名稱。");
    return cyberbizReportToolResult(await cyberbizReportService(context).queryPayout({
      ...(period ? { period } : {}),
      scopeType: scopeType as CyberbizPayoutQuery["scopeType"],
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(scopeId ? { scopeId } : {}),
      ...(scopeName ? { scopeName } : {}),
      ...(reportGroupByInput(input) ? { groupBy: reportGroupByInput(input) } : {}),
    }), "payout", input);
  },
};

export const PLATFORM_TOOL_DEFINITIONS: readonly PlatformToolDefinition[] = [
  platformOpenMeteoTool,
  listItemsTool,
  wmsListInventoryTool,
  wmsSearchWarehouseTool,
  wmsGetInventoryItemTool,
  wmsListLowStockTool,
  wmsGetActivityTool,
  crmSearchCustomersTool,
  crmGetCustomerTool,
  crmGetOrdersTool,
  listReportScopesTool,
  cyberbizQuerySalesReportTool,
  cyberbizQueryPayoutReportTool,
];

export const PLATFORM_TOOL_KEYS = PLATFORM_TOOL_DEFINITIONS.map((tool) => tool.key);
export const PLATFORM_TOOL_MAP = new Map(PLATFORM_TOOL_DEFINITIONS.map((tool) => [tool.key, tool]));

export function toolsForSurface(surface: ToolSurface): PlatformToolDefinition[] {
  return PLATFORM_TOOL_DEFINITIONS.filter((tool) => tool.surfaces.includes(surface)).slice();
}

export { OPEN_METEO_TOOL_KEY };
export type { ToolContract, ToolContext, ToolSurface } from "./contract.js";
