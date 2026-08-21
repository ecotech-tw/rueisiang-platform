import {
  ASSISTANT_TIME_ZONE,
  AssistantError,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
} from "@rueisiang/assistant";
import {
  createOrderClient,
  type CyberbizOrder,
  type CyberbizOrderListFilters,
} from "@rueisiang/cyberbiz";
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

function taipeiDayRange(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new AssistantError("CRM 日期請使用 YYYY-MM-DD 格式。");
  }
  const start = new Date(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime())) throw new AssistantError("CRM 日期格式無效。");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ASSISTANT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(start);
  const normalized = [
    parts.find((part) => part.type === "year")?.value,
    parts.find((part) => part.type === "month")?.value,
    parts.find((part) => part.type === "day")?.value,
  ].join("-");
  if (normalized !== date) throw new AssistantError("CRM 日期格式無效。");
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
  return { from: start.toISOString(), to: end.toISOString() };
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
export const CRM_GET_CUSTOMER_ORDERS_TOOL_KEY = "crm_get_customer_orders";
export const CRM_GET_CUSTOMER_SPENDING_SUMMARY_TOOL_KEY = "crm_get_customer_spending_summary";

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
  description: "搜尋與篩選 CRM 客戶資料，適合先找出客戶 ID，再取得單一客戶的完整背景；可依 Asia/Taipei 某天新增或更新的客戶篩選。若要查訂單或消費紀錄，請再使用 CRM 客戶消費工具。只讀。",
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
      date: { type: "string", description: "指定日期，使用 YYYY-MM-DD；例如今天要填入系統提供的 currentDate。可留空。" },
      dateField: { type: "string", description: "日期欄位：createdAt 查詢當天新增客戶，updatedAt 查詢當天更新客戶。預設 createdAt。", enum: ["createdAt", "updatedAt"] },
      page: { type: "string", description: "頁碼，預設 1。" },
      pageSize: { type: "string", description: "每頁筆數，可用 10、25、50 或 100，預設 25。" },
      sortField: { type: "string", description: "排序欄位：name、phone、sourceChannel、status、createdAt 或 updatedAt。預設 updatedAt。" },
      sortDirection: { type: "string", description: "排序方向：asc 或 desc。預設 desc。", enum: ["asc", "desc"] },
    },
  },
  async execute(input, context) {
    const search = textInput(input, "search");
    if (search.length > 120) throw new AssistantError("CRM 客戶搜尋關鍵字不能超過 120 字。");
    const date = textInput(input, "date");
    const dateField = textInput(input, "dateField") === "updatedAt" ? "updatedAt" : "createdAt";
    const dateRange = date ? taipeiDayRange(date) : null;

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
    const result = await listCustomers(database(context), query, dateRange
      ? dateField === "updatedAt"
        ? { updatedFrom: dateRange.from, updatedTo: dateRange.to }
        : { createdFrom: dateRange.from, createdTo: dateRange.to }
      : {});
    return json({
      ...result,
      query,
      dateFilter: dateRange ? { date, field: dateField, timeZone: ASSISTANT_TIME_ZONE } : null,
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
  | { kind: "not_found"; customerId: string }
  | { kind: "unlinked"; subject: CustomerOrderSubject }
  | {
    kind: "matched";
    subject: CustomerOrderSubject;
    orders: CyberbizOrder[];
    filters: CyberbizOrderListFilters;
    dateRange: { fromDate: string | null; toDate: string | null; timeZone: string };
    hasMore: boolean;
    truncated: boolean;
    scannedPages: number;
  };

const MAX_ORDER_SCAN_PAGES = 20;

function cyberbizToolEnv(context: ToolContext | undefined): CyberbizToolEnv {
  const env = (context?.env ?? {}) as CyberbizToolEnv;
  if (!env.CYBERBIZ_API_TOKEN) {
    throw new AssistantError("尚未設定 CYBERBIZ_API_TOKEN，無法即時查詢 CYBERBIZ 消費紀錄。");
  }
  return env;
}

function normalizePhoneCandidates(value: string): string[] {
  const digits = value.replace(/\D/gu, "");
  if (!digits) return [];
  const candidates = new Set([digits]);
  if (digits.startsWith("886") && digits.length > 3) candidates.add(`0${digits.slice(3)}`);
  if (digits.startsWith("0") && digits.length > 1) candidates.add(`886${digits.slice(1)}`);
  return [...candidates];
}

function samePhone(left: string, right: string): boolean {
  const rightCandidates = new Set(normalizePhoneCandidates(right));
  return normalizePhoneCandidates(left).some((candidate) => rightCandidates.has(candidate));
}

function sameEmail(left: string, right: string): boolean {
  return Boolean(left.trim() && right.trim() && left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase());
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

async function resolveCustomerOrderIdentity(input: unknown, context: ToolContext | undefined): Promise<CustomerOrderIdentity> {
  const customerId = textInput(input, "customerId");
  const customer = customerId ? await findCustomer(database(context), customerId) : null;
  if (customerId && !customer) {
    return {
      customer: null,
      subject: {
        crmCustomerId: customerId,
        cyberbizCustomerId: null,
        name: "",
        phone: "",
        email: "",
      },
    };
  }

  const subject = customerOrderSubject(customer, input);
  if (!subject.cyberbizCustomerId && !subject.phone && !subject.email) {
    throw new AssistantError("CRM 查詢消費紀錄需要 customerId、cyberbizCustomerId、phone 或 email 其中一項。");
  }
  return { customer, subject };
}

function orderMatchesCustomer(order: CyberbizOrder, subject: CustomerOrderSubject): boolean {
  const cyberbizIdMatches = Boolean(
    subject.cyberbizCustomerId && order.customer.id && subject.cyberbizCustomerId === order.customer.id,
  );
  const emailMatches = [order.customer.email, order.buyerEmail].some((email) => sameEmail(subject.email, email));
  const phoneMatches = [order.customer.phone, order.buyerPhone, order.receiverPhone]
    .some((phone) => samePhone(subject.phone, phone));
  return cyberbizIdMatches || emailMatches || phoneMatches;
}

function orderQueryFilters(input: unknown): {
  filters: CyberbizOrderListFilters;
  dateRange: { fromDate: string | null; toDate: string | null; timeZone: string };
} {
  const fromDate = textInput(input, "fromDate") || null;
  const toDate = textInput(input, "toDate") || null;
  if (fromDate && toDate && fromDate > toDate) {
    throw new AssistantError("CRM 消費紀錄的 fromDate 不能晚於 toDate。");
  }

  const financialStatus = textInput(input, "financialStatus");
  const fulfillmentStatus = textInput(input, "fulfillmentStatus");
  return {
    filters: {
      ...(fromDate ? { startTime: cyberbizDateTime(fromDate, false) } : {}),
      ...(toDate ? { endTime: cyberbizDateTime(toDate, true) } : {}),
      ...(financialStatus ? { financialStatuses: [financialStatus] } : {}),
      ...(fulfillmentStatus ? { fulfillmentStatuses: [fulfillmentStatus] } : {}),
    },
    dateRange: { fromDate, toDate, timeZone: ASSISTANT_TIME_ZONE },
  };
}

async function lookupCustomerOrders(
  input: unknown,
  context: ToolContext | undefined,
  defaultLimit: number,
  maxLimit: number,
): Promise<CustomerOrderLookup> {
  const identity = await resolveCustomerOrderIdentity(input, context);
  if (textInput(input, "customerId") && !identity.customer) {
    return { kind: "not_found", customerId: textInput(input, "customerId") };
  }
  if (!identity.subject.cyberbizCustomerId && !identity.subject.phone && !identity.subject.email) {
    return { kind: "unlinked", subject: identity.subject };
  }

  const { filters, dateRange } = orderQueryFilters(input);
  const requestedLimit = Math.min(maxLimit, boundedNumber(input, "limit", defaultLimit, maxLimit));
  const env = cyberbizToolEnv(context);
  const client = createOrderClient({ apiToken: env.CYBERBIZ_API_TOKEN!, baseUrl: env.CYBERBIZ_API_BASE_URL });
  const orders: CyberbizOrder[] = [];
  let scannedPages = 0;
  let hasMore = false;

  for (let page = 1; page <= MAX_ORDER_SCAN_PAGES; page += 1) {
    const result = await client.fetchPage({ ...filters, page, perPage: 50, offset: (page - 1) * 50 });
    scannedPages += 1;
    for (const order of result.orders) {
      if (orderMatchesCustomer(order, identity.subject)) orders.push(order);
    }
    hasMore = result.hasMore;
    if (orders.length >= requestedLimit || !result.hasMore || result.orders.length === 0) break;
  }

  return {
    kind: "matched",
    subject: identity.subject,
    orders: orders.slice(0, requestedLimit),
    filters,
    dateRange,
    hasMore,
    truncated: hasMore && scannedPages >= MAX_ORDER_SCAN_PAGES,
    scannedPages,
  };
}

function orderToolResult(lookup: CustomerOrderLookup): string {
  if (lookup.kind === "not_found") return json({ found: false, customerId: lookup.customerId });
  if (lookup.kind === "unlinked") {
    return json({
      found: true,
      linked: false,
      customer: lookup.subject,
      message: "CRM 客戶尚未有可用的 CYBERBIZ customer id、phone 或 email，無法比對即時訂單。",
    });
  }
  return json({
    source: "cyberbiz_live",
    customer: lookup.subject,
    dateRange: lookup.dateRange,
    filters: lookup.filters,
    totalReturned: lookup.orders.length,
    hasMore: lookup.hasMore,
    truncated: lookup.truncated,
    scannedPages: lookup.scannedPages,
    retrievedAt: new Date().toISOString(),
    orders: lookup.orders,
  });
}

const crmGetCustomerOrdersTool: PlatformToolDefinition = {
  key: CRM_GET_CUSTOMER_ORDERS_TOOL_KEY,
  label: "CRM 查詢客戶消費紀錄",
  description: "即時查詢 CYBERBIZ 訂單並依 CRM customerId、CYBERBIZ customerId、電話或 email 比對客戶；可依 Asia/Taipei 日期與付款／配送狀態篩選。這是即時訂單資料，不是 CRM 操作紀錄。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "mcp"],
  requiredPermissions: ["crm:order:read"],
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "CRM 客戶 ID，通常先由 crm_search_customers 取得。" },
      cyberbizCustomerId: { type: "string", description: "CYBERBIZ customer ID；若已有此 ID 可直接查詢。" },
      phone: { type: "string", description: "客戶電話，可用來比對 CYBERBIZ 訂單。" },
      email: { type: "string", description: "客戶 email，可用來比對 CYBERBIZ 訂單。" },
      fromDate: { type: "string", description: "訂單建立起始日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      toDate: { type: "string", description: "訂單建立結束日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      financialStatus: { type: "string", description: "付款狀態，例如 paid、cod、refunded；可留空。" },
      fulfillmentStatus: { type: "string", description: "配送狀態，例如 unshipped、fulfilled、received；可留空。" },
      limit: { type: "string", description: "最多回傳幾筆訂單，預設 10，最多 25。" },
    },
  },
  async execute(input, context) {
    return orderToolResult(await lookupCustomerOrders(input, context, 10, 25));
  },
};

const crmGetCustomerSpendingSummaryTool: PlatformToolDefinition = {
  key: CRM_GET_CUSTOMER_SPENDING_SUMMARY_TOOL_KEY,
  label: "CRM 客戶消費摘要",
  description: "即時查詢 CYBERBIZ 訂單，彙整客戶訂單數、消費金額、平均客單價、最近消費與熱銷商品；可依 Asia/Taipei 日期與付款／配送狀態篩選。結果可能受掃描上限影響。只讀。",
  defaultStatus: "development",
  surfaces: ["sandbox", "mcp"],
  requiredPermissions: ["crm:order:read"],
  parameters: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "CRM 客戶 ID，通常先由 crm_search_customers 取得。" },
      cyberbizCustomerId: { type: "string", description: "CYBERBIZ customer ID；若已有此 ID 可直接查詢。" },
      phone: { type: "string", description: "客戶電話，可用來比對 CYBERBIZ 訂單。" },
      email: { type: "string", description: "客戶 email，可用來比對 CYBERBIZ 訂單。" },
      fromDate: { type: "string", description: "訂單建立起始日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      toDate: { type: "string", description: "訂單建立結束日，YYYY-MM-DD，使用 Asia/Taipei；可留空。" },
      financialStatus: { type: "string", description: "付款狀態，例如 paid、cod、refunded；可留空。" },
      fulfillmentStatus: { type: "string", description: "配送狀態，例如 unshipped、fulfilled、received；可留空。" },
    },
  },
  async execute(input, context) {
    const lookup = await lookupCustomerOrders(input, context, 100, 100);
    if (lookup.kind !== "matched") return orderToolResult(lookup);

    const amounts = lookup.orders
      .map((order) => order.totalPrice)
      .filter((value): value is number => value !== null);
    const totalSpent = Math.round(amounts.reduce((total, amount) => total + amount, 0) * 100) / 100;
    const productMap = new Map<string, { name: string; sku: string; quantity: number; spent: number }>();
    for (const order of lookup.orders) {
      for (const item of order.lineItems) {
        const key = `${item.sku}|${item.title}|${item.variantTitle}`;
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

    return json({
      source: "cyberbiz_live",
      customer: lookup.subject,
      dateRange: lookup.dateRange,
      filters: lookup.filters,
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
  crmGetCustomerOrdersTool,
  crmGetCustomerSpendingSummaryTool,
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
