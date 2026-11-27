import { CyberbizApiError, CyberbizInventoryConflictError, parseCyberbizOrder, type CyberbizInventoryClient, type CyberbizOrder, type CyberbizOrderClient } from "@rueisiang/cyberbiz";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { parseDbDate, toDbTimestamp } from "./db-timestamp.js";
import { hasUnresolvedOrderRestock } from "./order-restock-state.js";
import { activityEvents } from "./schema/activity.js";
import { cyberbizWebhookEvents } from "./schema/crm.js";
import { cyberbizOrderRestocks, type CyberbizOrderRestock, type OrderRestockMode, type OrderRestockState } from "./schema/cyberbiz-order-restocks.js";
import { cyberbizSyncLocks } from "./schema/wms.js";
import { claimCyberbizSyncLock, listCompanyLinks, releaseCyberbizSyncLock } from "./wms-sync.js";
import { WmsError } from "./wms.js";
import { claimFailedCyberbizWebhookEvent, requeueStaleCyberbizWebhookEvents } from "./webhook-events.js";

const MAX_ATTEMPTS = 3;
const MAX_EVENT_AGE_MS = 15 * 60_000;
const WEB_SOURCES = new Set(["手機", "電腦", "mobile", "desktop", "web"]);
const PHASE_LABEL = { create: "下單回補", cancel: "取消回補校正" };
const STATE_LABEL: Record<OrderRestockState, string> = {
  pending: "等待處理", checking: "核對中", applying: "送出中", applied: "已調整", unchanged: "無須調整",
  observed: "僅觀察", skipped: "不適用", review: "待人工確認",
};

class ReviewRequired extends Error {}

export function orderRestockMode(value?: string): OrderRestockMode {
  return value === "apply" ? "apply" : "observe";
}

function isWebOrder(order: CyberbizOrder): boolean {
  return !order.posShopId && order.shippingType.toLowerCase() !== "pos" && WEB_SOURCES.has(order.sourceDevice.toLowerCase());
}

function orderLines(order: CyberbizOrder) {
  if (order.statuses.returnStatus && order.statuses.returnStatus !== "no_need") {
    throw new ReviewRequired("訂單包含整單退貨或未知退貨狀態，未自動調整。");
  }
  const groups = new Map<string, { productId: string; variantId: string; sku: string; quantity: number }>();
  if (!order.lineItems.length || order.lineItems.length > 40) throw new ReviewRequired("訂單明細為空或超過 40 筆，未自動調整。");
  for (const line of order.lineItems) {
    if (!line.productId || !line.productVariantId || !line.sku.trim() || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ReviewRequired("訂單明細缺少商品身分或正整數數量，未自動調整。");
    }
    if (line.hasRelatedItems || (line.returnStatus && line.returnStatus !== "no_need")) {
      throw new ReviewRequired("訂單包含組合內容或退貨明細，不能把訂購數量直接當成庫存數量。");
    }
    const next = { productId: line.productId, variantId: line.productVariantId, sku: line.sku.trim(), quantity: line.quantity };
    const previous = groups.get(next.variantId);
    if (previous) {
      if (previous.productId !== next.productId || previous.sku !== next.sku) throw new ReviewRequired("同款式有互相矛盾的商品身分。");
      next.quantity += previous.quantity;
    }
    if (!Number.isSafeInteger(next.quantity)) throw new ReviewRequired("訂單數量超出安全範圍。");
    groups.set(next.variantId, next);
  }
  return [...groups.values()];
}

function audit(row: CyberbizOrderRestock, actor?: { id: string; email: string }) {
  return activityRow({
    entityType: "cyberbiz_order_restock",
    entityId: row.orderId,
    entityLabel: `${row.orderName} ${row.sku}`.trim(),
    eventType: `order_restock_${row.state}`,
    summary: `${PHASE_LABEL[row.phase]}・${STATE_LABEL[row.state]}・訂單 ${row.orderName}（${row.orderId}）${row.sku ? `・${row.sku} × ${row.quantity}` : ""}・${row.reason}${row.targetQuantity === null ? "" : `（WMS 目標 ${row.targetQuantity}）`}`,
    source: "cyberbiz_webhook",
    field: "quantity",
    oldValue: row.remoteBefore === null ? null : String(row.remoteBefore),
    newValue: row.remoteAfter === null ? null : String(row.remoteAfter),
    status: row.state === "review" ? "failed" : row.state === "pending" ? "pending" : "succeeded",
    error: row.state === "review" || (row.state === "pending" && row.attempts > 0) ? row.reason : null,
    payload: { restockId: row.id },
    actor,
  });
}

function auditInsert(db: Database, row: CyberbizOrderRestock, actor?: { id: string; email: string }, afterUpdate = false) {
  const event = { ...audit(row, actor), createdAt: row.updatedAt };
  const fields = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, sql`${value}`.as(key)])) as { [K in keyof typeof event]: SQL.Aliased<(typeof event)[K]> };
  return db.insert(activityEvents).select(db.select(fields).from(cyberbizOrderRestocks).where(and(
    eq(cyberbizOrderRestocks.id, row.id), ...(afterUpdate ? [sql`changes() > 0`] : []),
  )));
}

async function finish(db: Database, row: CyberbizOrderRestock, patch: Partial<CyberbizOrderRestock>, actor?: { id: string; email: string }, expectedStates?: OrderRestockState[]) {
  const next = { ...row, ...patch, updatedAt: toDbTimestamp() };
  const [updated] = await db.batch([
    db.update(cyberbizOrderRestocks).set({ ...patch, updatedAt: next.updatedAt }).where(and(
      eq(cyberbizOrderRestocks.id, row.id), inArray(cyberbizOrderRestocks.state, expectedStates ?? [row.state]),
      ...(expectedStates ? [] : [eq(cyberbizOrderRestocks.updatedAt, row.updatedAt)]),
    )).returning(),
    // changes() 是同 batch 前一個 UPDATE 的結果，CAS 失敗不得留下虛假的完成稽核。
    auditInsert(db, next, actor, true),
  ]);
  return { row: updated[0] ?? await getOrderRestock(db, row.id), changed: updated.length > 0 };
}

export interface OrderWebhookOutcome {
  eventId: string;
  topic: string;
  status: "processed" | "ignored" | "duplicate" | "failed";
  orderId?: string;
  reason?: string;
  queued?: number;
  mode?: OrderRestockMode;
}

/** 只接收、驗證明細並建立防重工作；遠端 I/O 交給 response 後的 bounded drain。 */
export async function receiveOrderRestock(db: Database, input: {
  rawBody: string; eventId: string; topic: string; mode: OrderRestockMode;
}): Promise<OrderWebhookOutcome> {
  const parsed = JSON.parse(input.rawBody) as Record<string, unknown> | null;
  const order = parseCyberbizOrder(parsed?.order ?? parsed?.data ?? parsed);
  const phase = input.topic === "orders/create" ? "create" : input.topic === "orders/cancelled" ? "cancel" : null;
  const originals = order.id ? await db.select().from(cyberbizOrderRestocks).where(and(
    eq(cyberbizOrderRestocks.orderId, order.id), eq(cyberbizOrderRestocks.phase, "create"), eq(cyberbizOrderRestocks.mode, "apply"),
  )) : [];
  const mutableStates: OrderRestockState[] = ["pending", "checking", "applying", "applied"];
  const protectedOriginals = originals.filter((row) => row.state === "review" || mutableStates.includes(row.state));
  let reason = "已排入回補核對；尚未調整庫存。";
  let state: OrderRestockState = "pending";
  let lines: ReturnType<typeof orderLines> = [];
  if (!phase) reason = "此訂單事件僅保存，不進行庫存回補。";
  else if (!order.id) reason = "訂單沒有 ID，不進行庫存回補。";
  else if (!isWebOrder(order)) {
    state = "skipped";
    reason = order.posShopId || order.shippingType.toLowerCase() === "pos" || order.sourceDevice.toLowerCase() === "pos"
      ? "POS 訂單不回補，公司倉與門市庫存不得混用。" : "訂單來源未列入官網白名單，不自動回補。";
  } else {
    try { lines = orderLines(order); }
    catch (error) {
      state = "review";
      reason = error instanceof Error ? error.message : "訂單明細無法解析。";
      // 不自動調整整單，但保留可精確辨識的品項，避免快照／盤點繞過待確認保護。
      const knownLinks = await listCompanyLinks(db);
      const identities = new Map<string, { productId: string; variantId: string; sku: string; quantity: number }>();
      for (const line of order.lineItems) {
        if (!line.productId || !line.productVariantId || !line.sku.trim()) continue;
        const identity = { productId: line.productId, variantId: line.productVariantId, sku: line.sku.trim(), quantity: Number.isSafeInteger(line.quantity) && line.quantity > 0 ? line.quantity : 0 };
        const linked = knownLinks.some((link) => link.cyberbizProductId === identity.productId && link.cyberbizVariantId === identity.variantId && link.linkedSku.trim().toUpperCase() === identity.sku.toUpperCase());
        if (!identities.has(identity.variantId) || linked) identities.set(identity.variantId, identity);
      }
      lines = [...identities.values()];
    }
  }

  // 同一雜湊事件補跑時帳本可能尚未收齊，不能把接收中斷誤判成改單。
  const resumingReceipt = phase === "create" && originals.every((row) => row.eventId === input.eventId && row.mode === input.mode);
  if (protectedOriginals.length && !resumingReceipt) {
    let manifestMatches = false;
    try {
      const current = orderLines(order);
      manifestMatches = isWebOrder(order) && current.length === originals.length
        && originals.every((original) => current.some((line) => line.productId === original.productId && line.variantId === original.variantId && line.sku === original.sku && line.quantity === original.quantity));
    } catch { /* 缺少明細時沿用原帳本圈出品項，不以空身分解除保護。 */ }
    if (!manifestMatches || (phase === "cancel" && input.mode === "observe")) {
      state = "review";
      reason = phase === "cancel" ? "訂單取消明細／來源不完整、已變更或目前停用寫入，回補工作須人工確認。" : "訂單商品明細／來源或退貨狀態變更，回補工作須人工確認。";
      for (const original of protectedOriginals) {
        if (original.state !== "review") await finish(db, original, { state: "review", reason }, undefined, mutableStates);
      }
      if (phase) {
        const identities = new Map(lines.map((line) => [line.variantId, line]));
        for (const original of protectedOriginals) identities.set(original.variantId, { productId: original.productId, variantId: original.variantId, sku: original.sku, quantity: original.quantity });
        lines = [...identities.values()];
      }
    }
  }

  let queued = 0;
  if (phase && order.id) {
    if (!lines.length) lines = [{ productId: "", variantId: "", sku: "", quantity: 0 }];
    for (const line of lines) {
      const links = line.productId ? await listCompanyLinks(db, { productId: line.productId }) : [];
      const link = links.find((value) => value.cyberbizVariantId === line.variantId && value.linkedSku.trim().toUpperCase() === line.sku.toUpperCase());
      const now = toDbTimestamp();
      const row: CyberbizOrderRestock = {
        id: crypto.randomUUID(), eventId: input.eventId,
        orderId: order.id, orderName: order.orderName || order.orderNumber || order.id,
        phase, source: order.sourceDevice, ...line, itemId: link?.inventoryItemId ?? null,
        mode: input.mode, state, reason, orderCreatedAt: order.createdAt,
        targetQuantity: null, remoteBefore: null, remoteAfter: null, attempts: 0, startedAt: null, createdAt: now, updatedAt: now,
      };
      // batch 原子寫入；業務鍵衝突時不替未插入的 UUID 產生幽靈稽核。
      const [inserted] = await db.batch([
        db.insert(cyberbizOrderRestocks).values(row).onConflictDoNothing().returning(),
        auditInsert(db, row),
      ]);
      queued += inserted.filter((value) => value.state === "pending").length;
    }
  }
  const outcome: OrderWebhookOutcome = {
    eventId: input.eventId, topic: input.topic, orderId: order.id || undefined,
    status: queued || state === "review" ? "processed" : "ignored", queued, mode: input.mode, ...(reason ? { reason } : {}),
  };
  await db.update(cyberbizWebhookEvents).set({
    status: outcome.status, resultJson: JSON.stringify(outcome), processedAt: toDbTimestamp(), updatedAt: toDbTimestamp(),
  }).where(eq(cyberbizWebhookEvents.id, input.eventId));
  return outcome;
}

export interface OrderRestockClients {
  inventoryClient?: CyberbizInventoryClient;
  orderClient?: CyberbizOrderClient;
}

async function runRestock(db: Database, initial: CyberbizOrderRestock, clients: OrderRestockClients) {
  let row = initial;
  let lock: string | null = null;
  let sending = false;
  try {
    if (row.mode === "apply" && row.itemId) {
      lock = await claimCyberbizSyncLock(db, row.itemId);
      if (!lock) return;
    }
    const claimed = await db.update(cyberbizOrderRestocks).set({
      state: "checking", attempts: sql`${cyberbizOrderRestocks.attempts} + 1`, startedAt: toDbTimestamp(), updatedAt: toDbTimestamp(),
    }).where(and(eq(cyberbizOrderRestocks.id, row.id), eq(cyberbizOrderRestocks.state, "pending"))).returning();
    if (!claimed.length) return;
    row = claimed[0]!;
    if (!row.itemId) throw new ReviewRequired("訂單款式未精確連結 WMS 公司倉，請確認商品／款式 ID，不以同 SKU 猜測。");
    if (row.mode === "apply" && await hasUnresolvedOrderRestock(db, row.itemId!, row.id)) {
      throw new ReviewRequired("同品項另有未確認回補，不以單張訂單覆蓋可能包含其他異動的庫存。");
    }
    if (row.phase === "cancel") {
      const [original] = await db.select().from(cyberbizOrderRestocks).where(and(
        eq(cyberbizOrderRestocks.orderId, row.orderId), eq(cyberbizOrderRestocks.phase, "create"), eq(cyberbizOrderRestocks.variantId, row.variantId),
      ));
      if (!original || original.state === "skipped" || original.state === "unchanged" || original.state === "observed") {
        await finish(db, row, { state: "skipped", reason: "這張訂單沒有已執行的下單回補，不額外扣除取消回補量。" });
        return;
      }
      if (original.state !== "applied" || original.mode !== "apply" || original.quantity !== row.quantity || original.itemId !== row.itemId) {
        throw new ReviewRequired("原下單回補尚未確認，或取消明細已變更，不自動反向調整。");
      }
    }
    if (!clients.orderClient || !clients.inventoryClient) throw new Error("未設定 CYBERBIZ API，無法重讀訂單與庫存。");
    const latest = await clients.orderClient.fetchOne(row.orderId);
    if (latest.id !== row.orderId || !isWebOrder(latest)) throw new ReviewRequired("重讀訂單的 ID 或官網來源不符。");
    const line = orderLines(latest).find((value) => value.variantId === row.variantId);
    if (!line || line.productId !== row.productId || line.sku !== row.sku || line.quantity !== row.quantity) {
      throw new ReviewRequired("訂單已改單或商品明細不符，未自動調整。");
    }
    const cancelled = latest.statuses.orderStatus === "cancelled" || Boolean(latest.timings.cancelledAt);
    if (row.phase === "create" && cancelled) {
      await finish(db, row, { state: "skipped", reason: "訂單已取消，不執行延遲到達的下單回補。" });
      return;
    }
    if (row.phase === "cancel" && !cancelled) throw new ReviewRequired("訂單尚未確認取消，不扣除取消回補量。");
    if (row.phase === "create" && latest.statuses.fulfillmentStatus !== "unfulfilled") {
      throw new ReviewRequired("訂單已出貨或配送狀態不明，可能已實際出庫，不自動回補。");
    }
    const eventTime = row.phase === "create" ? latest.createdAt : latest.timings.cancelledAt;
    const time = new Date(eventTime).getTime();
    if (row.mode === "apply" && (!Number.isFinite(time) || Date.now() - time > MAX_EVENT_AGE_MS || time > Date.now() + 60_000)) {
      throw new ReviewRequired("事件已超過 15 分鐘安全窗口或時間無效，不回補可能已出庫的歷史訂單。");
    }
    const [link] = await listCompanyLinks(db, { inventoryItemId: row.itemId! });
    if (!link || link.cyberbizProductId !== row.productId || link.cyberbizVariantId !== row.variantId || link.linkedSku.trim().toUpperCase() !== row.sku.toUpperCase()) {
      throw new ReviewRequired("WMS 連結已變更或不屬於訂單原款式。");
    }
    const baselineTime = link.updatedAt ? parseDbDate(link.updatedAt)?.getTime() : undefined;
    const secondPrecision = !/\.\d+(?:Z|[+-]\d{2}:\d{2})?$/.test(link.updatedAt ?? "");
    const ambiguousSecond = baselineTime !== undefined && secondPrecision && Math.floor(baselineTime / 1000) === Math.floor(time / 1000);
    if (row.mode === "apply" && (baselineTime === undefined || !Number.isFinite(time) || baselineTime >= time || ambiguousSecond)) {
      throw new ReviewRequired("WMS 在事件後已被更新，無法確認是否混入訂單扣減或實體異動，不使用此數量覆蓋官網。");
    }
    if (!Number.isSafeInteger(link.quantity) || link.quantity < 0) throw new ReviewRequired("WMS 數量不是非負安全整數。");
    const remotes = await clients.inventoryClient.fetchProduct(row.productId);
    const remote = remotes.find((value) => value.productId === row.productId && value.variantId === row.variantId && value.sku.trim().toUpperCase() === row.sku.toUpperCase());
    if (!remote || remote.posShopId) throw new ReviewRequired("重讀商品並非原公司倉款式，未調整門市庫存。");
    if (remote.quantityValid === false || !Number.isSafeInteger(remote.quantity)) throw new ReviewRequired("官網庫存數量缺值或不是安全整數，未自動調整。");
    row = { ...row, targetQuantity: link.quantity, remoteBefore: remote.quantity };
    if (!remote.inventoryManagement) {
      await finish(db, row, { state: "skipped", targetQuantity: link.quantity, remoteBefore: remote.quantity, reason: "商品未管理庫存，不進行回補。" });
      return;
    }
    const expected = row.phase === "create" ? link.quantity - row.quantity : link.quantity + row.quantity;
    if (row.mode === "observe") {
      await finish(db, row, {
        state: "observed", targetQuantity: link.quantity, remoteBefore: remote.quantity,
        reason: remote.quantity === expected ? "差額符合訂單數量；目前為觀察模式，未寫入官網。" : `差額不符（預期官網 ${expected}），僅記錄、不寫入。`,
      });
      return;
    }
    if (remote.quantity === link.quantity) {
      await finish(db, row, { state: "unchanged", targetQuantity: link.quantity, remoteBefore: remote.quantity, remoteAfter: remote.quantity, reason: "官網已等於 WMS，未送出差額；不能據此認定曾做過回補。" });
      return;
    }
    if (remote.quantity !== expected) throw new ReviewRequired(`官網 ${remote.quantity} 與 WMS ${link.quantity} 的差額不等於本單 ${row.quantity}；可能有調倉或其他訂單，不覆蓋。`);
    const result = await clients.inventoryClient.setCompanyQuantity({
      productId: row.productId, variantId: row.variantId, sku: row.sku, targetQuantity: link.quantity, expectedQuantity: expected,
      beforeAdjust: async () => {
        const [current] = await listCompanyLinks(db, { inventoryItemId: row.itemId! });
        if (!current || current.quantity !== link.quantity || current.updatedAt !== link.updatedAt || current.cyberbizVariantId !== row.variantId || current.cyberbizProductId !== row.productId) {
          throw new ReviewRequired("送出前 WMS 數量或連結已變更，未調整官網。");
        }
        const [lease] = await db.select({ itemId: cyberbizSyncLocks.itemId }).from(cyberbizSyncLocks).where(and(
          eq(cyberbizSyncLocks.itemId, row.itemId!), eq(cyberbizSyncLocks.token, lock!), sql`${cyberbizSyncLocks.leaseUntil} > CURRENT_TIMESTAMP`,
        )).limit(1);
        if (!lease) throw new ReviewRequired("送出前同步 lease 已失效，未調整官網。");
        // 持久化成功後才允許 POST；crash／timeout 後只能人工確認，不重新送差額。
        const [active] = await db.update(cyberbizOrderRestocks).set({ state: "applying", targetQuantity: link.quantity, remoteBefore: remote.quantity, updatedAt: toDbTimestamp() }).where(and(
          eq(cyberbizOrderRestocks.id, row.id), eq(cyberbizOrderRestocks.state, "checking"), eq(cyberbizOrderRestocks.updatedAt, row.updatedAt),
        )).returning();
        if (!active) throw new ReviewRequired("送出前工作已被訂單異動轉人工查核，未調整官網。");
        row = active;
        sending = true;
      },
    });
    await finish(db, row, {
      state: result.changed ? "applied" : "unchanged", targetQuantity: link.quantity, remoteBefore: result.previousQuantity, remoteAfter: result.quantity,
      reason: row.phase === "create" ? "下單扣減已中和；WMS 數量未變，實際出庫仍由現場操作。" : "取消訂單的原生回補已校正；WMS 實體庫存未變。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "回補失敗";
    const review = sending || error instanceof ReviewRequired || error instanceof CyberbizInventoryConflictError
      || (error instanceof CyberbizApiError && !error.retryable) || row.mode === "observe" || row.attempts >= MAX_ATTEMPTS;
    await finish(db, row, {
      state: review ? "review" : "pending", targetQuantity: row.targetQuantity, remoteBefore: row.remoteBefore,
      reason: sending ? `遠端寫入結果需人工確認，禁止自動重送：${message}` : message,
    });
  } finally {
    if (lock && row.itemId) await releaseCyberbizSyncLock(db, row.itemId, lock);
  }
}

/** 每輪有界；只有確定尚未送出 POST 的工作可以重試。 */
export async function drainOrderRestocks(db: Database, clients: OrderRestockClients & { mode: OrderRestockMode; limit?: number }) {
  const stale = await db.select().from(cyberbizOrderRestocks).where(and(
    inArray(cyberbizOrderRestocks.state, ["checking", "applying"]),
    sql`julianday(${cyberbizOrderRestocks.updatedAt}) < julianday('now', '-5 minutes')`,
  )).limit(10);
  for (const row of stale) await finish(db, row, { state: "review", reason: "工作中斷，遠端結果未確認；不自動重播庫存差額。" });
  if (clients.mode === "observe") {
    const paused = await db.select().from(cyberbizOrderRestocks).where(and(
      eq(cyberbizOrderRestocks.state, "pending"), eq(cyberbizOrderRestocks.mode, "apply"),
    )).limit(10);
    for (const row of paused) {
      const token = row.itemId ? await claimCyberbizSyncLock(db, row.itemId) : null;
      if (row.itemId && !token) continue;
      try {
        const current = await getOrderRestock(db, row.id);
        if (current.state === "pending") await finish(db, current, { state: "review", reason: "庫存寫入已停用；尚未送出的工作轉人工查核，不自動補跑。" });
      } finally {
        if (row.itemId && token) await releaseCyberbizSyncLock(db, row.itemId, token);
      }
    }
  }
  const rows = await db.select().from(cyberbizOrderRestocks).where(and(
    eq(cyberbizOrderRestocks.state, "pending"), inArray(cyberbizOrderRestocks.mode, clients.mode === "apply" ? ["apply", "observe"] : ["observe"]),
  )).orderBy(asc(cyberbizOrderRestocks.createdAt), asc(cyberbizOrderRestocks.id)).limit(Math.min(5, Math.max(1, clients.limit ?? 5)));
  for (const row of rows) await runRestock(db, row, clients);
  return { attempted: rows.length, interrupted: stale.length };
}

export async function retryOrderRestockWebhooks(db: Database) {
  await requeueStaleCyberbizWebhookEvents(db, "order");
  const events = await db.select().from(cyberbizWebhookEvents).where(and(
    eq(cyberbizWebhookEvents.entityType, "order"), eq(cyberbizWebhookEvents.status, "failed"),
  )).orderBy(asc(cyberbizWebhookEvents.receivedAt)).limit(5);
  for (const event of events) {
    if (!await claimFailedCyberbizWebhookEvent(db, event.id, "order")) continue;
    let mode: OrderRestockMode = "observe";
    try { mode = orderRestockMode((JSON.parse(event.resultJson) as { mode?: string } | null)?.mode); }
    catch { /* 舊事件沒有可靠的接收模式，不追溯升級寫入。 */ }
    try { await receiveOrderRestock(db, { rawBody: event.payloadJson, topic: event.topic, eventId: event.id, mode }); }
    catch (error) {
      await db.update(cyberbizWebhookEvents).set({ status: "failed", lastError: error instanceof Error ? error.message : "訂單回補排程失敗", updatedAt: toDbTimestamp() }).where(eq(cyberbizWebhookEvents.id, event.id));
    }
  }
  return { attempted: events.length };
}

export async function getOrderRestock(db: Database, id: string) {
  const [row] = await db.select().from(cyberbizOrderRestocks).where(eq(cyberbizOrderRestocks.id, id));
  if (!row) throw new WmsError("not_found", "找不到這筆回補紀錄。");
  return row;
}

/** 只登記人工核對的結果，不呼叫庫存 API。狀態及稽核必須在同一個 batch 完成。 */
export async function resolveOrderRestock(db: Database, input: {
  id: string; resolution: "applied" | "skipped"; reason: string; actor: { id: string; email: string };
}) {
  if (input.reason.trim().length < 5 || input.reason.trim().length > 1000) throw new WmsError("invalid", "請輸入 5 至 1000 個字，說明查核單據及實際處理結果。");
  const row = await getOrderRestock(db, input.id);
  if (row.state !== "review") throw new WmsError("conflict", "只有待人工確認的回補可以登記查核結果。");
  if (input.resolution === "applied" && (row.mode !== "apply" || !row.itemId || row.targetQuantity === null || row.remoteBefore === null)) {
    throw new WmsError("invalid", "未進入實際調整核對的工作，不能標記成回補已完成。");
  }
  const token = row.itemId ? await claimCyberbizSyncLock(db, row.itemId) : null;
  if (row.itemId && !token) throw new WmsError("conflict", "商品正在同步，請稍後再確認。");
  try {
    const current = await getOrderRestock(db, input.id);
    if (current.state !== "review") throw new WmsError("conflict", "紀錄已被其他操作更新。");
    const reason = `人工確認：${input.reason.trim()}`;
    const { row: resolved, changed } = await finish(db, current, { state: input.resolution, reason }, input.actor);
    if (!changed) throw new WmsError("conflict", "紀錄已被其他操作更新，請重新查核。");
    return resolved;
  } finally {
    if (token && row.itemId) await releaseCyberbizSyncLock(db, row.itemId, token);
  }
}
