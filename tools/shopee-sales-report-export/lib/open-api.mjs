const COLUMN_COUNT = 35;

const COLUMN = Object.freeze({
  orderSn: 0,
  orderStatus: 1,
  createdAt: 5,
  productAmount: 6,
  commissionFee: 18,
  serviceFee: 19,
  transactionFee: 20,
  itemName: 24,
  itemId: 25,
  modelName: 26,
  quantity: 33,
  returnQuantity: 34,
});

export const SHOPEE_ORDERS_HEADERS = Object.freeze([
  "訂單編號", "訂單狀態", "", "", "", "訂單成立日期", "商品總價", "", "", "", "", "", "", "", "", "", "", "",
  "成交手續費", "其他服務費", "金流與系統處理費", "", "", "", "商品名稱", "商品ID", "商品選項名稱", "", "", "", "", "", "", "", "數量", "退貨數量",
]);

function responseBody(value) {
  const response = value?.response;
  return response && typeof response === "object" && !Array.isArray(response) ? response : value;
}

function listFrom(value, keys, label) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  const body = responseBody(value);
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  if (body && typeof body === "object" && (body.order_sn || body.order || body.order_income)) return [body];
  throw new Error(`${label} 必須是陣列，或包含可辨識的 response。`);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function number(value, label) {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").trim());
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是有效數字：${value}`);
  return parsed;
}

function requiredText(value, label) {
  const result = text(value);
  if (!result) throw new Error(`${label} 不可為空。`);
  return result;
}

function formatCreatedAt(value, label) {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(raw)) return raw.slice(0, 16).replace("T", " ");
  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`${label} 不是有效的 Unix timestamp：${value}`);
  const date = new Date((timestamp > 1e12 ? timestamp : timestamp * 1000));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} 不是有效的 Unix timestamp：${value}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function orderFromRecord(record) {
  const body = responseBody(record);
  return body?.order && typeof body.order === "object" ? body.order : body;
}

function indexByOrderSn(records, label, mapper = orderFromRecord) {
  const result = new Map();
  for (const record of records) {
    const order = mapper(record);
    const orderSn = requiredText(order?.order_sn, `${label} 的 order_sn`);
    if (result.has(orderSn)) throw new Error(`${label} 出現重複的訂單：${orderSn}`);
    result.set(orderSn, order);
  }
  return result;
}

function incomeFromRecord(record) {
  const body = responseBody(record);
  const order = orderFromRecord(record);
  return order?.order_income ?? body?.order_income ?? order?.income ?? body?.income ?? null;
}

function productAmount(income, orderSn) {
  for (const field of ["product_amount", "merchandise_subtotal", "item_amount"]) {
    if (income?.[field] != null) return number(income[field], `訂單 ${orderSn} 的 ${field}`);
  }
  // buyer_total_amount 會包含運費，escrow_amount 會扣掉費用；兩者都不能拿來冒充商品總價。
  throw new Error(`訂單 ${orderSn} 缺少已確認的商品總價欄位（product_amount）。`);
}

function returnItems(records) {
  const result = [];
  for (const record of records) {
    const body = responseBody(record);
    const items = body?.item_list ?? body?.return_item_list ?? body?.items;
    if (Array.isArray(items)) {
      for (const item of items) result.push({ ...body, ...item });
    } else {
      result.push(body);
    }
  }
  return result;
}

function returnKey(orderSn, itemId, modelId = "") {
  return `${orderSn}\u0000${itemId}\u0000${modelId}`;
}

function indexReturnQuantities(records) {
  const result = new Map();
  for (const item of returnItems(records)) {
    const orderSn = requiredText(item?.order_sn ?? item?.order?.order_sn, "Returns API 的 order_sn");
    const itemId = requiredText(item?.item_id, `訂單 ${orderSn} 的退貨 item_id`);
    const modelId = text(item?.model_id ?? item?.modelId);
    const quantity = number(item?.return_quantity ?? item?.model_quantity_returned ?? item?.quantity, `訂單 ${orderSn} 的退貨數量`);
    const key = returnKey(orderSn, itemId, modelId);
    result.set(key, (result.get(key) ?? 0) + quantity);
  }
  return result;
}

function itemReturnQuantity(returnQuantities, orderSn, item) {
  const itemId = text(item?.item_id);
  const modelId = text(item?.model_id ?? item?.modelId);
  return returnQuantities.get(returnKey(orderSn, itemId, modelId))
    ?? returnQuantities.get(returnKey(orderSn, itemId))
    ?? 0;
}

/**
 * 將 Open API 各端點的回應整理成既有 xlsx `orders` 工作表的列。
 * 商品金額先要求上游明確整理成 product_amount，避免把含運費或已扣費用的欄位誤當成業績基礎。
 */
export function ordersRowsFromOpenApi(input = {}) {
  const orderList = input.orderList ?? input.order_list;
  const orderDetails = input.orderDetails ?? input.order_details;
  const escrowDetails = input.escrowDetails ?? input.escrow_details;
  const returnDetails = input.returnDetails ?? input.return_details ?? [];
  const orderRecords = listFrom(orderList, ["order_list"], "get_order_list");
  const detailRecords = listFrom(orderDetails, ["order_list", "order_details"], "get_order_detail");
  const escrowRecords = listFrom(escrowDetails, ["escrow_list", "escrow_details"], "get_escrow_detail");
  const returnRecords = listFrom(returnDetails, ["return_list", "return_details"], "Returns API");
  const orderIds = [];
  const seenOrderIds = new Set();
  for (const record of orderRecords) {
    const orderSn = requiredText(orderFromRecord(record)?.order_sn, "get_order_list 的 order_sn");
    if (!seenOrderIds.has(orderSn)) {
      seenOrderIds.add(orderSn);
      orderIds.push(orderSn);
    }
  }
  const details = indexByOrderSn(detailRecords, "get_order_detail");
  const incomes = indexByOrderSn(escrowRecords, "get_escrow_detail", (record) => {
    const body = responseBody(record);
    const order = orderFromRecord(record);
    const income = incomeFromRecord(record);
    return { order_sn: order?.order_sn ?? body?.order_sn ?? income?.order_sn, order_income: income };
  });
  for (const orderSn of [...details.keys(), ...incomes.keys()]) {
    if (!seenOrderIds.has(orderSn)) {
      seenOrderIds.add(orderSn);
      orderIds.push(orderSn);
    }
  }
  if (orderIds.length === 0) throw new Error("Open API 回應沒有任何訂單。");
  const returnQuantities = indexReturnQuantities(returnRecords);
  const rows = [Array.from({ length: COLUMN_COUNT }, (_, index) => SHOPEE_ORDERS_HEADERS[index] ?? "")];
  for (const orderSn of orderIds) {
    const detail = details.get(orderSn);
    const escrow = incomes.get(orderSn);
    if (!detail) throw new Error(`訂單 ${orderSn} 缺少 get_order_detail 回應。`);
    if (!escrow?.order_income) throw new Error(`訂單 ${orderSn} 缺少 get_escrow_detail 回應。`);
    const items = detail.item_list;
    if (!Array.isArray(items) || items.length === 0) throw new Error(`訂單 ${orderSn} 缺少商品明細。`);
    const income = escrow.order_income;
    const values = {
      orderStatus: text(detail.order_status),
      createdAt: formatCreatedAt(detail.create_time, `訂單 ${orderSn} 的 create_time`),
      productAmount: productAmount(income, orderSn),
      commissionFee: number(income.commission_fee, `訂單 ${orderSn} 的 commission_fee`),
      serviceFee: number(income.service_fee, `訂單 ${orderSn} 的 service_fee`),
      transactionFee: number(income.transaction_fee ?? income.seller_transaction_fee, `訂單 ${orderSn} 的 transaction_fee`),
    };
    for (const item of items) {
      const itemId = requiredText(item?.item_id, `訂單 ${orderSn} 的 item_id`);
      const row = Array(COLUMN_COUNT).fill("");
      row[COLUMN.orderSn] = orderSn;
      row[COLUMN.orderStatus] = values.orderStatus;
      row[COLUMN.createdAt] = values.createdAt;
      row[COLUMN.productAmount] = values.productAmount;
      row[COLUMN.commissionFee] = values.commissionFee;
      row[COLUMN.serviceFee] = values.serviceFee;
      row[COLUMN.transactionFee] = values.transactionFee;
      row[COLUMN.itemName] = text(item.item_name);
      row[COLUMN.itemId] = itemId;
      row[COLUMN.modelName] = text(item.model_name);
      row[COLUMN.quantity] = number(item.model_quantity_purchased ?? item.quantity_purchased ?? item.quantity, `訂單 ${orderSn} 的商品數量`);
      row[COLUMN.returnQuantity] = itemReturnQuantity(returnQuantities, orderSn, item);
      rows.push(row);
    }
  }
  return rows;
}
