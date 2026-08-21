import { cyberbizRequest, type CyberbizConfig, type RequestOptions } from "./http.js";

/**
 * CYBERBIZ 訂單 API 的安全、可供工具使用的資料形狀。
 *
 * 這裡不把原始 payload 往上層傳，避免模型意外看到付款、收件或平台內部欄位。
 */
export interface CyberbizOrderCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export interface CyberbizOrderLineItem {
  id: string;
  productId: string;
  productVariantId: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  price: number | null;
  totalPriceBeforeDiscounts: number | null;
  totalDiscount: number | null;
  totalPriceAfterDiscounts: number | null;
  returnStatus: string;
}

export interface CyberbizOrderStatuses {
  orderStatus: string;
  financialStatus: string;
  fulfillmentStatus: string;
  returnStatus: string;
}

export interface CyberbizOrderTimings {
  refundAt: string;
  closedAt: string;
  cancelledAt: string;
}

export interface CyberbizOrder {
  id: string;
  orderNumber: string;
  orderName: string;
  createdAt: string;
  updatedAt: string;
  customer: CyberbizOrderCustomer;
  buyerEmail: string;
  buyerPhone: string;
  receiverPhone: string;
  subtotalPrice: number | null;
  totalPrice: number | null;
  shippingPrice: number | null;
  statuses: CyberbizOrderStatuses;
  timings: CyberbizOrderTimings;
  lineItems: CyberbizOrderLineItem[];
}

export interface CyberbizOrderListFilters {
  startTime?: string;
  endTime?: string;
  updatedAtStartTime?: string;
  updatedAtEndTime?: string;
  closedAtStartTime?: string;
  closedAtEndTime?: string;
  refundAtStartTime?: string;
  refundAtEndTime?: string;
  cancelledAtStartTime?: string;
  cancelledAtEndTime?: string;
  statuses?: string[];
  financialStatuses?: string[];
  fulfillmentStatuses?: string[];
  returnStatuses?: string[];
  tags?: string[];
  excludedTags?: string[];
  dataSource?: string;
  vendor?: string;
  page?: number;
  perPage?: number;
  offset?: number;
}

export interface CyberbizOrderPage {
  orders: CyberbizOrder[];
  page: number;
  perPage: number;
  offset: number;
  totalPages: number | null;
  totalOrders: number | null;
  hasMore: boolean;
}

export interface CyberbizOrderClient {
  fetchPage(filters?: CyberbizOrderListFilters): Promise<CyberbizOrderPage>;
}

export const MAX_ORDER_PAGE_SIZE = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function readTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const raw = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(raw)
    ? `${raw.replace(" ", "T")}+08:00`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function readStatus(record: Record<string, unknown>, keys: string[]): string {
  return firstString(record, keys).toLowerCase();
}

function readOrderItems(order: Record<string, unknown>): CyberbizOrderLineItem[] {
  const rawItems = Array.isArray(order.line_items)
    ? order.line_items
    : Array.isArray(order.lineItems)
      ? order.lineItems
      : [];

  return rawItems.map((value) => {
    const item = firstRecord(value);
    return {
      id: firstString(item, ["id", "line_item_id"]),
      productId: firstString(item, ["product_id", "productId"]),
      productVariantId: firstString(item, ["product_variant_id", "productVariantId", "variant_id"]),
      title: firstString(item, ["title", "product_title", "name"]),
      variantTitle: firstString(item, ["variant_title", "variantTitle"]),
      sku: firstString(item, ["sku"]),
      quantity: Math.max(0, Math.round(firstNumber(item, ["quantity"]) ?? 0)),
      price: firstNumber(item, ["price"]),
      totalPriceBeforeDiscounts: firstNumber(item, ["total_price_before_discounts"]),
      totalDiscount: firstNumber(item, ["total_discount"]),
      totalPriceAfterDiscounts: firstNumber(item, ["total_price_after_discounts"]),
      returnStatus: readStatus(item, ["return_status", "returnStatus"]),
    };
  });
}

export function parseCyberbizOrder(payload: unknown): CyberbizOrder {
  const order = asRecord(payload) ?? {};
  const customer = firstRecord(order.customer);
  const buyer = firstRecord(order.buyer);
  const receiver = firstRecord(order.receiver);
  const prices = firstRecord(order.prices);
  const statuses = firstRecord(order.statuses);
  const timings = firstRecord(order.timings);

  return {
    id: firstString(order, ["id", "order_id"]),
    orderNumber: firstString(order, ["order_number", "orderNumber"]),
    orderName: firstString(order, ["order_name", "name"]),
    createdAt: readTimestamp(order.created_at ?? order.createdAt),
    updatedAt: readTimestamp(order.updated_at ?? order.updatedAt),
    customer: {
      id: firstString(customer, ["id", "customer_id", "member_id"]),
      name: firstString(customer, ["name", "full_name", "display_name"]),
      email: firstString(customer, ["email", "email_address"]),
      phone: firstString(customer, ["mobile", "phone"]),
    },
    buyerEmail: firstString(buyer, ["email", "email_address"]),
    buyerPhone: firstString(buyer, ["mobile", "phone"]),
    receiverPhone: firstString(receiver, ["phone", "mobile"]),
    subtotalPrice: firstNumber(order, ["subtotal_price"]) ?? firstNumber(prices, ["total_line_items_price"]),
    totalPrice: firstNumber(order, ["total_price"]) ?? firstNumber(prices, ["total_price"]),
    shippingPrice: firstNumber(order, ["shipping_rate_price"]) ?? firstNumber(prices, ["shipping_rate_price"]),
    statuses: {
      orderStatus: readStatus(statuses, ["order_status", "orderStatus"]) || readStatus(order, ["status"]),
      financialStatus: readStatus(statuses, ["financial_status", "financialStatus"]),
      fulfillmentStatus: readStatus(statuses, ["fulfillment_status", "fulfillmentStatus"]),
      returnStatus: readStatus(statuses, ["return_status", "returnStatus"]),
    },
    timings: {
      refundAt: readTimestamp(timings.refund_at ?? timings.refundAt),
      closedAt: readTimestamp(timings.closed_at ?? timings.closedAt),
      cancelledAt: readTimestamp(timings.cancelled_at ?? timings.cancelledAt),
    },
    lineItems: readOrderItems(order),
  };
}

function readOrders(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload) ?? {};
  for (const key of ["orders", "data", "items"]) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }
  return [];
}

function setListParam(params: URLSearchParams, key: string, value: string[] | undefined): void {
  if (value?.length) params.set(key, value.join(","));
}

function orderQuery(filters: CyberbizOrderListFilters): string {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const perPage = Math.min(MAX_ORDER_PAGE_SIZE, Math.max(1, Math.floor(filters.perPage ?? MAX_ORDER_PAGE_SIZE)));
  const offset = Math.max(0, Math.floor(filters.offset ?? (page - 1) * perPage));
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage), offset: String(offset) });
  const scalarParams: Array<[string, string | undefined]> = [
    ["start_time", filters.startTime],
    ["end_time", filters.endTime],
    ["updated_at_start_time", filters.updatedAtStartTime],
    ["updated_at_end_time", filters.updatedAtEndTime],
    ["closed_at_start_time", filters.closedAtStartTime],
    ["closed_at_end_time", filters.closedAtEndTime],
    ["refund_at_start_time", filters.refundAtStartTime],
    ["refund_at_end_time", filters.refundAtEndTime],
    ["cancelled_at_start_time", filters.cancelledAtStartTime],
    ["cancelled_at_end_time", filters.cancelledAtEndTime],
    ["data_source", filters.dataSource],
    ["vendor", filters.vendor],
  ];
  for (const [key, value] of scalarParams) if (value) params.set(key, value);
  setListParam(params, "statuses", filters.statuses);
  setListParam(params, "financial_statuses", filters.financialStatuses);
  setListParam(params, "fulfillment_statuses", filters.fulfillmentStatuses);
  setListParam(params, "return_statuses", filters.returnStatuses);
  setListParam(params, "tags", filters.tags);
  setListParam(params, "excluded_tags", filters.excludedTags);
  return params.toString();
}

export function createOrderClient(
  config: CyberbizConfig,
  options: RequestOptions = {},
): CyberbizOrderClient {
  const request = (path: string, extra: RequestOptions = {}) =>
    cyberbizRequest(config, path, { ...options, ...extra });

  return {
    async fetchPage(filters = {}) {
      const page = Math.max(1, Math.floor(filters.page ?? 1));
      const perPage = Math.min(MAX_ORDER_PAGE_SIZE, Math.max(1, Math.floor(filters.perPage ?? MAX_ORDER_PAGE_SIZE)));
      const offset = Math.max(0, Math.floor(filters.offset ?? (page - 1) * perPage));
      const { payload, headers } = await request(`/v1/orders?${orderQuery({ ...filters, page, perPage, offset })}`);
      const root = asRecord(payload) ?? {};
      const orders = readOrders(payload).map(parseCyberbizOrder);
      const totalPagesValue = Number(headers.get("x-total-pages") || root.total_pages || 0);
      const totalOrdersValue = Number(headers.get("x-total-count") || root.total_count || root.total || 0);
      const totalPages = Number.isFinite(totalPagesValue) && totalPagesValue > 0 ? totalPagesValue : null;
      const totalOrders = Number.isFinite(totalOrdersValue) && totalOrdersValue > 0 ? totalOrdersValue : null;

      return {
        orders,
        page,
        perPage,
        offset,
        totalPages,
        totalOrders,
        hasMore: totalPages !== null ? page < totalPages : orders.length >= perPage,
      };
    },
  };
}
