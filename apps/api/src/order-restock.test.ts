import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createInventoryClient, createOrderClient } from "@rueisiang/cyberbiz";
import {
  applySyncPlan, buildSyncPlan, claimCyberbizSyncLock, countItem, createDatabase, dispatchCyberbizWebhook,
  drainOrderRestocks, getOrderRestock, hasUnresolvedOrderRestock, listActivity, listCompanyLinks,
  orderRestockMode, releaseCyberbizSyncLock, resolveOrderRestock, retryFailedCyberbizPushes, retryOrderRestockWebhooks, syncSystemRoles,
} from "@rueisiang/db";
import { activityEvents, cyberbizOrderRestocks, cyberbizProducts, cyberbizWebhookEvents, items, userPermissionGrants, users, wmsItems } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";
import app from "./index.js";

const config = { baseUrl: "https://cyberbiz.example.test", apiToken: "test-token" };
let d1: ReturnType<typeof createTargetOnlyD1>;
let db: ReturnType<typeof createDatabase>;
let quantity: number;
let remotePosId: number | null;
let managed: boolean;
let currentOrder: ReturnType<typeof orderPayload>;
let writes: Record<string, unknown>[];
let postFailure: boolean;
let readFailure: boolean;
let beforeSecondRead: (() => Promise<void>) | undefined;
let beforeFirstRead: (() => Promise<void>) | undefined;
let beforeVerifyRead: (() => Promise<void>) | undefined;
let productReads: number;
let onPost: (() => void) | undefined;
let rawQuantityOverride: { value: unknown } | undefined;

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 700, order_name: "#700", order_number: 700,
    created_at: new Date(Date.now() - 10_000).toISOString(), updated_at: new Date().toISOString(),
    from_device: "手機", shipping_type: "family_c2c_prepaid", pos_info: null,
    statuses: { order_status: "open", fulfillment_status: "unfulfilled", financial_status: "paid" },
    timings: { cancelled_at: null as string | null },
    customer: { id: 500, name: "不應寫入 CRM 的訂單客戶", mobile: "0912345678" },
    line_items: [{ id: 900, product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 5, related_items: [] }],
    ...overrides,
  };
}

const clients = () => ({
  inventoryClient: createInventoryClient(config, { retries: 0, sleep: async () => {} }),
  orderClient: createOrderClient(config, { retries: 0, sleep: async () => {} }),
});
async function receive(mode: "observe" | "apply" = "apply", payload: Record<string, unknown> = currentOrder, topic = "orders/create") {
  return dispatchCyberbizWebhook(db, { rawBody: JSON.stringify(payload), topic, restockMode: mode });
}
async function run(mode: "observe" | "apply" = "apply") {
  return drainOrderRestocks(db, { ...clients(), mode });
}
async function job(phase = "create") {
  return (await db.select().from(cyberbizOrderRestocks).where(eq(cyberbizOrderRestocks.phase, phase as "create" | "cancel")))[0]!;
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
  await db.insert(items).values({ id: "soap", sku: "SOAP", name: "香皂", source: "cyberbiz", kind: "sellable" });
  await db.insert(wmsItems).values({ itemId: "soap", quantity: 12742, updatedAt: new Date(Date.now() - 60_000).toISOString() });
  await db.insert(cyberbizProducts).values({ itemId: "soap", cyberbizProductId: "100", cyberbizVariantId: "200" });
  quantity = 12737; remotePosId = null; managed = true; postFailure = false; readFailure = false;
  writes = []; productReads = 0; beforeSecondRead = undefined; beforeFirstRead = undefined; beforeVerifyRead = undefined; onPost = undefined; rawQuantityOverride = undefined; currentOrder = orderPayload();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/v1/orders/")) {
      if (readFailure) throw new Error("訂單查詢暫時失敗");
      return Response.json(currentOrder);
    }
    if (url.pathname === "/v1/products/100") {
      productReads += 1;
      if (productReads === 1) await beforeFirstRead?.();
      if (productReads === 2) await beforeSecondRead?.();
      const fetchedQuantity = rawQuantityOverride ? rawQuantityOverride.value : quantity;
      if (productReads === 3) await beforeVerifyRead?.();
      return Response.json({ id: 100, title: "香皂", pos_shop: remotePosId ? { id: remotePosId } : null,
        product_variants: [{ id: 200, sku: "SOAP", inventory_management: managed, inventory_quantity: fetchedQuantity, safety_inventory_quantity: 5 }],
      });
    }
    if (url.pathname === "/v1/stock_adjustments") {
      expect(await db.select().from(cyberbizOrderRestocks).where(eq(cyberbizOrderRestocks.state, "applying"))).toHaveLength(1);
      onPost?.();
      const body = JSON.parse(String(init?.body)); writes.push(body);
      const adjustment = body.items[0];
      quantity += adjustment.type === "surplus" ? adjustment.quantity : -adjustment.quantity;
      if (postFailure) throw new Error("上游已套用，但回應遺失");
      return Response.json({ id: 1 });
    }
    throw new Error(`不預期的 API：${url.pathname}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("官網下單回補", () => {
  it("缺省及未知模式都只觀察", () => {
    expect(orderRestockMode()).toBe("observe");
    expect(orderRestockMode("APPLY")).toBe("observe");
    expect(orderRestockMode("apply")).toBe("apply");
  });

  it("12737 校正回 WMS 12742，只送一次 +5，不改 WMS", async () => {
    expect(await receive()).toMatchObject({ kind: "order", status: "processed", queued: 1 });
    expect((await job()).state).toBe("pending");
    await run();
    expect(quantity).toBe(12742);
    expect(writes).toEqual([{ pos_shop_id: 0, items: [{ sku: "SOAP", quantity: 5, type: "surplus" }] }]);
    expect((await db.select().from(wmsItems))[0]?.quantity).toBe(12742);
    expect(await job()).toMatchObject({ state: "applied", remoteBefore: 12737, remoteAfter: 12742, targetQuantity: 12742, attempts: 1 });
    expect((await db.select().from(cyberbizWebhookEvents))[0]?.entityType).toBe("order");
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM crm_customers").get()).toEqual({ n: 0 });
  });

  it("觀察模式記錄前值與目標，絕不呼叫寫入 API", async () => {
    await receive("observe"); await run("observe");
    expect(quantity).toBe(12737); expect(writes).toHaveLength(0);
    expect(await job()).toMatchObject({ state: "observed", remoteBefore: 12737, targetQuantity: 12742, remoteAfter: null });
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(false);
  });

  it("重送不同 JSON、改用其他訂單狀態或兩個 drain 並行，都不會重複回補", async () => {
    await receive();
    await receive("apply", { ...currentOrder, updated_at: new Date(Date.now() + 1).toISOString() });
    await receive("apply", currentOrder, "orders/paid");
    await Promise.all([run(), run()]); await run();
    expect(writes).toHaveLength(1); expect(quantity).toBe(12742);
    expect(await db.select().from(cyberbizOrderRestocks)).toHaveLength(1);
  });

  it("同款式多列明細先合併數量，避免第二列被防重略過", async () => {
    currentOrder = orderPayload({ line_items: [
      { id: 1, product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 2 },
      { id: 2, product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 3 },
    ] });
    await receive(); await run();
    expect((await job()).quantity).toBe(5); expect(writes).toHaveLength(1);
  });

  it.each([
    { from_device: "POS", shipping_type: "pos", pos_info: { pos_shop_id: 1373 } },
    { from_device: "手機", pos_info: { pos_shop_id: 1373 } },
    { from_device: "未知來源" },
  ])("POS 或來源不明不回補：%j", async (override) => {
    currentOrder = orderPayload(override); await receive(); await run();
    expect(writes).toHaveLength(0); expect((await job()).state).toBe("skipped");
  });

  it("同 SKU、不同款式或門市不能猜成公司倉", async () => {
    currentOrder = orderPayload({ line_items: [{ product_id: 100, product_variant_id: 201, sku: "SOAP", quantity: 5 }] });
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it.each([0, -1, 1.2, null])("數量 %s 不合法，整單不回補", async (amount) => {
    currentOrder = orderPayload({ line_items: [{ product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: amount }] });
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("組合品不把販售數量直接當單品庫存", async () => {
    currentOrder = orderPayload({ line_items: [{ product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 5, related_items: [{ quantity: 2 }] }] });
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("明細驗證失敗仍保留精確品項，官網快照與盤點不得繞過待確認保護", async () => {
    currentOrder = orderPayload({ line_items: [{ product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 5, related_items: [{ quantity: 2 }] }] });
    await receive();
    expect(await job()).toMatchObject({ state: "review", itemId: "soap", variantId: "200" });
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    const links = await listCompanyLinks(db);
    await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity: 12737, safetyQuantity: 5 }]), null);
    expect((await db.select().from(wmsItems))[0]?.quantity).toBe(12742);
    await expect(countItem(db, "soap", 12737, { id: "admin", email: "admin@example.test" })).rejects.toThrow("訂單回補");
    expect(writes).toHaveLength(0);
  });

  it("其他明細不合法也不遺失整單中可辨識的商品身分", async () => {
    currentOrder = orderPayload({ line_items: [
      { product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 5 },
      { product_id: 300, sku: "MISSING-VARIANT", quantity: 1 },
    ] });
    await receive(); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("一般贈品仍依實際明細納入，不因零元漏回補", async () => {
    currentOrder = orderPayload({ line_items: [{ product_id: 100, product_variant_id: 200, sku: "SOAP", quantity: 5, price: 0, item_type: "gift" }] });
    await receive(); await run(); expect(writes).toHaveLength(1);
  });

  it("門市商品或未管理庫存不調整", async () => {
    remotePosId = 1373; await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("未管理庫存的商品記錄為不適用", async () => {
    managed = false; await receive(); await run();
    expect((await job()).state).toBe("skipped"); expect(writes).toHaveLength(0);
  });

  it("差額超過訂單數量時不洗掉現場出庫／調倉", async () => {
    quantity = 12732; await receive(); await run();
    expect(await job()).toMatchObject({ state: "review", remoteBefore: 12732, targetQuantity: 12742 });
    expect(writes).toHaveLength(0); expect(quantity).toBe(12732);
  });

  it("官網等於 WMS 不代表本程式曾回補，取消時不反向扣庫存", async () => {
    quantity = 12742; await receive(); await run();
    expect((await job()).state).toBe("unchanged"); expect(writes).toHaveLength(0);
    currentOrder = orderPayload({ statuses: { order_status: "cancelled", fulfillment_status: "unfulfilled" }, timings: { cancelled_at: new Date().toISOString() } });
    await receive("apply", currentOrder, "orders/cancelled"); await run();
    expect((await job("cancel")).state).toBe("skipped"); expect(writes).toHaveLength(0);
  });

  it("送差額前官網再變動，不使用舊讀值計算的差額", async () => {
    beforeSecondRead = async () => { quantity -= 20; };
    await receive(); await run();
    expect(writes).toHaveLength(0); expect(quantity).toBe(12717);
    expect((await job()).state).toBe("review");
    beforeSecondRead = undefined; quantity = 12737;
    await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("送出前 WMS 被別的操作改過，不採用舊目標", async () => {
    beforeSecondRead = async () => { await db.update(wmsItems).set({ quantity: 12000 }).where(eq(wmsItems.itemId, "soap")); };
    await receive(); await run();
    expect(writes).toHaveLength(0); expect((await job()).state).toBe("review");
  });

  it("超過安全窗口或已出貨的延遲通知不回補", async () => {
    currentOrder = orderPayload({ created_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    await receive(); await run(); expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("WMS 在訂單成立後已更新，不把可能受污染的基準推回官網", async () => {
    await db.update(wmsItems).set({ updatedAt: new Date().toISOString() });
    await receive(); await run(); expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("SQL 秒精度基準與訂單在同一秒，即使盤點數量未變也不能自動回補", async () => {
    const second = new Date().toISOString().slice(0, 19);
    vi.spyOn(Date, "now").mockReturnValue(new Date(`${second}.500Z`).getTime());
    currentOrder = orderPayload({ created_at: `${second}.100Z` });
    // 實際盤點於該秒後半更新，但 CURRENT_TIMESTAMP 只留下秒精度。
    await db.update(wmsItems).set({ updatedAt: second.replace("T", " ") });
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("寫入已套用但回應遺失：保留待確認，不讓重送或 cron 再加一次", async () => {
    postFailure = true; await receive(); await run(); await receive(); await run();
    expect(quantity).toBe(12742); expect(writes).toHaveLength(1);
    expect(await job()).toMatchObject({ state: "review", remoteAfter: null });
    expect((await job()).reason).toContain("禁止自動重送");
  });

  it("後台在遠端讀取後又出庫，差額只加回本單，驗證不符轉人工且不重送", async () => {
    onPost = () => { quantity -= 5; };
    await receive(); await run(); await run();
    expect(quantity).toBe(12737); expect(writes).toHaveLength(1);
    expect((await job()).state).toBe("review");
  });

  it("POST 前的讀取錯誤可以有限重試，不影響遠端庫存", async () => {
    readFailure = true; await receive(); await run();
    expect((await job()).state).toBe("pending");
    readFailure = false; await run();
    expect((await job()).state).toBe("applied"); expect(writes).toHaveLength(1);
  });

  it("讀取連續失敗三次轉人工確認", async () => {
    readFailure = true; await receive(); await run(); await run(); await run(); await run();
    expect(await job()).toMatchObject({ state: "review", attempts: 3 }); expect(writes).toHaveLength(0);
  });

  it("程序死在可能送出之後，過期工作不重播差額", async () => {
    await receive();
    await db.update(cyberbizOrderRestocks).set({ state: "applying", updatedAt: "2020-01-01 00:00:00" });
    await run(); expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("多張未確認的同品項訂單不互相覆蓋", async () => {
    await receive(); await receive("apply", orderPayload({ id: 701, order_name: "#701" })); await run();
    expect((await db.select().from(cyberbizOrderRestocks)).every((row) => row.state === "review")).toBe(true);
    expect(writes).toHaveLength(0);
  });
});

describe("取消與其他庫存路徑", () => {
  it("只反向校正確實曾回補的訂單，平台 +5 後校正回 WMS，不動實體庫存", async () => {
    await receive(); await run(); quantity += 5;
    currentOrder = orderPayload({ statuses: { order_status: "cancelled", fulfillment_status: "unfulfilled" }, timings: { cancelled_at: new Date().toISOString() } });
    await receive("apply", currentOrder, "orders/cancelled"); await run(); await run();
    expect(quantity).toBe(12742); expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ items: [{ quantity: 5, type: "loss" }] });
    expect((await db.select().from(wmsItems))[0]?.quantity).toBe(12742);
  });

  it("取消先到、建立後到：重讀已取消訂單，不會錯補", async () => {
    quantity = 12742;
    currentOrder = orderPayload({ statuses: { order_status: "cancelled", fulfillment_status: "unfulfilled" }, timings: { cancelled_at: new Date().toISOString() } });
    await receive("apply", currentOrder, "orders/cancelled"); await run();
    await receive(); await run(); expect(writes).toHaveLength(0); expect((await job()).state).toBe("skipped");
  });

  it("有未確認回補時，手動匯入、商品通知與盤點都不能繞過保護", async () => {
    await receive();
    const links = await listCompanyLinks(db);
    const result = await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity: 12737, safetyQuantity: 5 }]), null);
    expect(result.failed).toBe(1);
    expect((await db.select().from(wmsItems))[0]?.quantity).toBe(12742);
    await expect(countItem(db, "soap", 12737, { id: "admin", email: "admin@example.test" })).rejects.toThrow("訂單回補");
  });

  it("舊盤點推送補跑也不能把未確認品項寫回官網", async () => {
    await receive();
    await db.insert(activityEvents).values({ id: "failed-push", entityType: "item", entityId: "soap", eventType: "cyberbiz_sync_failed", summary: "推送失敗", field: "quantity", source: "cyberbiz_sync" });
    await retryFailedCyberbizPushes(db, clients().inventoryClient);
    expect(writes).toHaveLength(0);
  });

  it("舊盤點補推讀取途中收到新訂單，POST 前會攔住，不冒充下單回補", async () => {
    await db.insert(activityEvents).values({ id: "old-push", entityType: "item", entityId: "soap", eventType: "cyberbiz_sync_failed", summary: "舊盤點推送失敗", field: "quantity", source: "cyberbiz_sync" });
    beforeFirstRead = async () => { await receive(); };
    await retryFailedCyberbizPushes(db, clients().inventoryClient);
    expect(writes).toHaveLength(0); expect(quantity).toBe(12737);
    expect((await job()).state).toBe("pending");
    await run(); expect((await job()).state).toBe("applied");
    quantity += 5;
    currentOrder = orderPayload({ statuses: { order_status: "cancelled", fulfillment_status: "unfulfilled" }, timings: { cancelled_at: new Date().toISOString() } });
    await receive("apply", currentOrder, "orders/cancelled"); await run();
    expect(quantity).toBe(12742); expect(writes).toHaveLength(2);
  });

  it("lease 忙碌保留工作，釋放後才處理", async () => {
    const lock = await claimCyberbizSyncLock(db, "soap"); await receive(); await run();
    expect((await job()).state).toBe("pending"); expect(writes).toHaveLength(0);
    await releaseCyberbizSyncLock(db, "soap", lock!); await run(); expect(writes).toHaveLength(1);
  });

  it("調倉通知單獨保存，不寫 CRM 或猜測庫存", async () => {
    const result = await dispatchCyberbizWebhook(db, { rawBody: JSON.stringify({ id: 999, items: [{ sku: "SOAP", quantity: 5 }] }), topic: "stock_requisitions/approved" });
    expect(result).toMatchObject({ kind: "stock", status: "ignored" });
    expect((await db.select().from(cyberbizWebhookEvents))[0]?.entityType).toBe("stock");
    expect(writes).toHaveLength(0);
  });

  it("稽核頁可以依訂單及 SKU 查詢，不回傳原始會員 payload", async () => {
    await receive("observe"); await run("observe");
    const result = await listActivity(db, { entityType: "cyberbiz_order_restock", source: "all", search: "SOAP", page: 1, pageSize: 25 });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]?.orderRestockId).toBe((await job()).id);
    expect(JSON.stringify(result)).not.toContain("0912345678");
    expect(await getOrderRestock(db, (await job()).id)).toMatchObject({ mode: "observe", targetQuantity: 12742 });
  });

  it("人工結案只記錄查核結果，不會再次呼叫 API", async () => {
    postFailure = true; await receive(); await run();
    const row = await job();
    const done = await resolveOrderRestock(db, { id: row.id, resolution: "applied", reason: "已核對平台調整單，確認加回五件", actor: { id: "admin", email: "admin@example.test" } });
    expect(done.state).toBe("applied"); expect(writes).toHaveLength(1);
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(false);
    const logs = await db.select().from(activityEvents).where(eq(activityEvents.actorId, "admin"));
    expect(logs).toHaveLength(1);
  });

  it("觀察模式或未核對目標的工作不能被冒充成已調整", async () => {
    quantity = 12730; await receive("observe"); await run("observe");
    await db.update(cyberbizOrderRestocks).set({ state: "review" });
    await expect(resolveOrderRestock(db, { id: (await job()).id, resolution: "applied", reason: "沒有實際遠端調整", actor: { id: "admin", email: "admin@example.test" } })).rejects.toThrow("未進入實際調整");
  });
});

const AUTH_SECRET = "test-auth-secret-test-auth-secret";
function runtimeEnv() {
  return { DB: d1, AUTH_SESSION_SECRET: AUTH_SECRET, GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    CYBERBIZ_WEBHOOK_SECRET: "webhook-secret", CYBERBIZ_API_TOKEN: config.apiToken, CYBERBIZ_API_BASE_URL: config.baseUrl };
}
async function authenticatedHeaders(permissions: Array<"wms:activity:read" | "wms:sync:trigger">) {
  await syncSystemRoles(db);
  const id = crypto.randomUUID(); const email = `${id}@example.test`;
  await db.insert(users).values({ id, email, status: "active" });
  for (const permission of permissions) await db.insert(userPermissionGrants).values({ userId: id, permission });
  const token = await signSession(newSessionClaims({ id, email, name: "管理者", pictureUrl: "" }), AUTH_SECRET);
  return { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Content-Type": "application/json" };
}

describe("回補安全故障與模式切換", () => {
  const invalidQuantities = [undefined, null, "", "不是數字", true, 0.4, "0.4", Number.MAX_SAFE_INTEGER + 1].map((value) => ({ value }));

  it.each(invalidQuantities)("第一次讀到無效原始數量 $value，不把補零或取整當作現值", async ({ value }) => {
    await db.update(wmsItems).set({ quantity: 5 }); quantity = 0;
    rawQuantityOverride = { value };
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it.each(invalidQuantities)("送出前第二次讀到無效原始數量 $value，停止而非重試", async ({ value }) => {
    await db.update(wmsItems).set({ quantity: 5 }); quantity = 0;
    beforeSecondRead = async () => { rawQuantityOverride = { value }; };
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
    rawQuantityOverride = undefined; await run();
    expect(writes).toHaveLength(0);
  });

  it("第二次商品讀取管理庫存已停用，不送出或自動重試", async () => {
    beforeSecondRead = async () => { managed = false; };
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it.each(["orders/update", "orders/create"])("已核對但尚未送出時由 %s 改單，不能把 checking 的人工查核覆蓋成 applying", async (topic) => {
    beforeSecondRead = async () => {
      currentOrder.line_items[0]!.quantity = 3;
      await receive("apply", currentOrder, topic);
    };
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
  });

  it.each(["orders/update", "orders/create", "orders/cancelled"])("POST 已送、驗證舊快照回來前收到 %s，writer 不得解除查核或留下假完成稽核", async (topic) => {
    beforeVerifyRead = async () => {
      if (topic !== "orders/cancelled") {
        currentOrder.line_items[0]!.quantity = 3; quantity += 2;
        await receive("apply", currentOrder, topic);
      } else {
        quantity += 5;
        await receive("apply", { id: 700, from_device: "手機", line_items: [] }, topic);
      }
      expect((await job()).state).toBe("review");
    };
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(1);
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    const activity = await db.select().from(activityEvents);
    expect(activity.some((row) => row.eventType === "order_restock_applied")).toBe(false);
    const links = await listCompanyLinks(db);
    expect((await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity, safetyQuantity: 5 }]), null)).failed).toBe(1);
    expect((await db.select().from(wmsItems))[0]!.quantity).toBe(12742);
  });

  it.each(["observe", "apply"] as const)("接收 %s 事件失敗，切換當前模式也不改寫接收模式", async (mode) => {
    currentOrder.created_at = new Date(Date.now() - 7 * 60_000).toISOString();
    await db.update(wmsItems).set({ updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    d1.sqlite.exec("CREATE TRIGGER fail_restock BEFORE INSERT ON cyberbiz_order_restocks BEGIN SELECT RAISE(ABORT, '模擬接收中斷'); END;");
    expect((await receive(mode)).status).toBe("failed");
    expect(JSON.parse((await db.select().from(cyberbizWebhookEvents))[0]!.resultJson)).toMatchObject({ mode });
    d1.sqlite.exec("DROP TRIGGER fail_restock; UPDATE cyberbiz_webhook_events SET status='processing', updated_at=datetime('now','-6 minutes');");
    await retryOrderRestockWebhooks(db); await run("apply");
    expect(await job()).toMatchObject({ mode, state: mode === "observe" ? "observed" : "applied" });
    expect(writes).toHaveLength(mode === "observe" ? 0 : 1);
  });

  it("舊 failed 事件缺少可靠接收模式，補跑只能觀察", async () => {
    d1.sqlite.exec("CREATE TRIGGER fail_restock BEFORE INSERT ON cyberbiz_order_restocks BEGIN SELECT RAISE(ABORT, '模擬接收中斷'); END;");
    await receive("apply");
    d1.sqlite.exec("DROP TRIGGER fail_restock; UPDATE cyberbiz_webhook_events SET result_json='{}';");
    await retryOrderRestockWebhooks(db); await run("apply");
    expect(await job()).toMatchObject({ mode: "observe", state: "observed" }); expect(writes).toHaveLength(0);
  });

  it.each(["observe", "apply"] as const)("同一 %s 事件只完成部分品項，補跑保留模式且不誤判成改單或產生幽靈稽核", async (mode) => {
    currentOrder.line_items.push({ id: 901, product_id: 101, product_variant_id: 201, sku: "CANDLE", quantity: 1, related_items: [] });
    d1.sqlite.exec("CREATE TRIGGER fail_second BEFORE INSERT ON cyberbiz_order_restocks WHEN NEW.variant_id='201' BEGIN SELECT RAISE(ABORT, '模擬第二品項中斷'); END;");
    await receive(mode);
    expect(await db.select().from(cyberbizOrderRestocks)).toHaveLength(1);
    d1.sqlite.exec("DROP TRIGGER fail_second;");
    await retryOrderRestockWebhooks(db);
    const rows = await db.select().from(cyberbizOrderRestocks);
    expect(rows).toHaveLength(2); expect(rows.every((row) => row.mode === mode && row.state === "pending")).toBe(true);
    expect(await db.select().from(activityEvents)).toHaveLength(2);
  });

  it("切回 observe 後，因 lease 忙碌未送出的 apply 工作可人工結案", async () => {
    await receive();
    const token = await claimCyberbizSyncLock(db, "soap");
    await run(); expect((await job()).state).toBe("pending");
    await run("observe"); expect((await job()).state).toBe("pending");
    await releaseCyberbizSyncLock(db, "soap", token!);
    await run("observe");
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
    const row = await job();
    await resolveOrderRestock(db, { id: row.id, resolution: "skipped", reason: "已停用且確認未送出庫存調整", actor: { id: "operator", email: "operator@example.test" } });
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(false);
    await run("apply"); expect(writes).toHaveLength(0);
  });

  it("已回補訂單以 create 重入改量，不能略過原已知品項的查核", async () => {
    await receive(); await run();
    currentOrder.line_items[0]!.quantity = 3; quantity += 2;
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    const links = await listCompanyLinks(db);
    expect((await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity, safetyQuantity: 5 }]), null)).failed).toBe(1);
    expect((await db.select().from(wmsItems))[0]!.quantity).toBe(12742); expect(writes).toHaveLength(1);
  });

  it.each([{ id: 700, from_device: "手機" }, { id: 700, from_device: "手機", line_items: [] }])("不完整 create 重入 %j，沿用原品項且不產生無連結 sentinel", async (partial) => {
    await receive(); await run();
    await receive("apply", partial);
    expect(await job()).toMatchObject({ state: "review", itemId: "soap", variantId: "200" });
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    expect(await db.select().from(cyberbizOrderRestocks)).toHaveLength(1);
  });

  it("create 重入只改非明細欄位仍維持防重，不誤鎖或補寫稽核", async () => {
    await receive(); await run();
    const originalActivity = await db.select().from(activityEvents);
    currentOrder.updated_at = new Date(Date.now() + 1000).toISOString();
    expect((await receive()).status).toBe("ignored"); await run();
    expect((await job()).state).toBe("applied"); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(false);
    expect(await db.select().from(activityEvents)).toHaveLength(originalActivity.length); expect(writes).toHaveLength(1);
  });

  it.each(["return_pending", "partially_returned", "unknown_return_state"])("首次整單退貨狀態 %s 不能因列上沒填狀態而自動回補", async (returnStatus) => {
    currentOrder = orderPayload({ statuses: { ...currentOrder.statuses, return_status: returnStatus } });
    await receive(); await run();
    expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
  });

  it.each(["return_pending", "partially_returned", "unknown_return_state"])("重讀才出現整單退貨狀態 %s 也不得送出", async (returnStatus) => {
    await receive();
    currentOrder = orderPayload({ statuses: { ...currentOrder.statuses, return_status: returnStatus } });
    await run(); expect((await job()).state).toBe("review"); expect(writes).toHaveLength(0);
  });

  it("整單 no_need 不影響正常回補", async () => {
    currentOrder = orderPayload({ statuses: { ...currentOrder.statuses, return_status: "no_need" } });
    await receive(); await run();
    expect((await job()).state).toBe("applied"); expect(writes).toHaveLength(1);
  });

  it.each(["apply", "observe"] as const)("盤點檢查後才插入 %s 工作，以 UPDATE 當下狀態決定且不留假成功稽核", async (mode) => {
    const token = await claimCyberbizSyncLock(db, "soap");
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementationOnce(async (statements) => {
      await receive(mode);
      return batch(statements);
    });
    try {
      const pending = countItem(db, "soap", 12000, { id: "counter", email: "counter@example.test" });
      if (mode === "apply") await expect(pending).rejects.toMatchObject({ kind: "conflict" });
      else await expect(pending).resolves.toMatchObject({ quantity: 12000, changed: true });
      expect((await db.select().from(wmsItems))[0]!.quantity).toBe(mode === "apply" ? 12742 : 12000);
      expect((await db.select().from(activityEvents)).filter((event) => event.eventType === "item_counted")).toHaveLength(mode === "apply" ? 0 : 1);
      expect((await job()).state).toBe("pending"); expect(writes).toHaveLength(0);
    } finally { await releaseCyberbizSyncLock(db, "soap", token!); }
  });

  it("沒有品項 lease 的並行人工結案，即使內容相同也只有成功更新者能回報成功", async () => {
    currentOrder.line_items[0]!.product_variant_id = 999;
    await receive(); await run();
    const row = await job();
    expect(row).toMatchObject({ itemId: null, state: "review" });
    const results = await Promise.allSettled(["operator-a", "operator-b"].map((id) => resolveOrderRestock(db, {
      id: row.id, resolution: "skipped", reason: "確認未曾送出庫存調整", actor: { id, email: `${id}@example.test` },
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ kind: "conflict" });
    expect((await db.select().from(activityEvents)).filter((event) => event.actorType === "user")).toHaveLength(1);
  });

  it("初始稽核失敗時帳本一起回滾，補跑只有一筆可查核紀錄", async () => {
    currentOrder.line_items[0]!.related_items = [{ sku: "PART" }] as never[];
    d1.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON activity_events BEGIN SELECT RAISE(ABORT, '模擬稽核中斷'); END;");
    expect((await receive()).status).toBe("failed");
    expect(await db.select().from(cyberbizOrderRestocks)).toHaveLength(0);
    expect(await db.select().from(activityEvents)).toHaveLength(0);
    d1.sqlite.exec("DROP TRIGGER fail_audit;");
    await retryOrderRestockWebhooks(db); await retryOrderRestockWebhooks(db);
    expect(await db.select().from(cyberbizOrderRestocks)).toHaveLength(1);
    expect((await job()).state).toBe("review"); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    const activity = await listActivity(db, { entityType: "cyberbiz_order_restock", source: "all", search: "SOAP", page: 1, pageSize: 50 });
    expect(activity.events).toHaveLength(1); expect(activity.events[0]!.orderRestockId).toBe((await job()).id);
  });

  it("observe 讀取期間不占用寫入 lease，既有商品同步仍可完成", async () => {
    beforeFirstRead = async () => {
      const links = await listCompanyLinks(db);
      const result = await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity, safetyQuantity: 5 }]), null);
      expect(result.failed).toBe(0);
    };
    await receive("observe"); await run("observe");
    expect((await job()).state).toBe("observed"); expect(writes).toHaveLength(0);
    expect((await db.select().from(wmsItems))[0]!.quantity).toBe(12737);
  });

  it.each([{}, { line_items: [] }, { from_device: "", line_items: [] }])("已回補訂單收到不完整取消 %j，依原帳本保護品項", async (changes) => {
    await receive(); await run();
    currentOrder = orderPayload({ statuses: { order_status: "cancelled", fulfillment_status: "unfulfilled" }, timings: { cancelled_at: new Date().toISOString() }, ...changes });
    const partial = { id: 700, from_device: "手機", ...changes };
    await receive("apply", partial, "orders/cancelled"); await run();
    expect(await job("cancel")).toMatchObject({ itemId: "soap", variantId: "200", state: "review" });
    expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    quantity = 12747;
    const links = await listCompanyLinks(db);
    const result = await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity, safetyQuantity: 5 }]), null);
    expect(result.failed).toBe(1); expect((await db.select().from(wmsItems))[0]!.quantity).toBe(12742);
    expect(writes).toHaveLength(1);
  });

  it("取消查核接收中斷後補跑，仍保留原已回補品項身分", async () => {
    await receive(); await run();
    d1.sqlite.exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON cyberbiz_order_restocks WHEN NEW.phase='cancel' BEGIN SELECT RAISE(ABORT, '模擬取消接收中斷'); END;");
    await receive("apply", { id: 700, from_device: "手機" }, "orders/cancelled");
    d1.sqlite.exec("DROP TRIGGER fail_cancel;");
    await retryOrderRestockWebhooks(db);
    expect(await job("cancel")).toMatchObject({ itemId: "soap", variantId: "200", state: "review" });
  });

  it("已回補訂單改量轉人工，不能把改單回補誤當實體回庫", async () => {
    await receive(); await run();
    currentOrder.line_items[0]!.quantity = 3;
    await receive("apply", currentOrder, "orders/update");
    expect((await job()).state).toBe("review"); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    quantity = 12744;
    const links = await listCompanyLinks(db);
    expect((await applySyncPlan(db, buildSyncPlan(links, [{ productId: "100", variantId: "200", sku: "SOAP", quantity, safetyQuantity: 5 }]), null)).failed).toBe(1);
    expect((await db.select().from(wmsItems))[0]!.quantity).toBe(12742); expect(writes).toHaveLength(1);
  });

  it("已回補訂單一般付款更新未改明細，不誤鎖品項", async () => {
    await receive(); await run();
    await receive("apply", currentOrder, "orders/update");
    expect((await job()).state).toBe("applied"); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(false);
  });

  it("原本已回補、切回 observe 才取消時保留查核，不把原生回補匯回 WMS", async () => {
    await receive(); await run();
    currentOrder = orderPayload({ statuses: { order_status: "cancelled", fulfillment_status: "unfulfilled" }, timings: { cancelled_at: new Date().toISOString() } });
    await receive("observe", currentOrder, "orders/cancelled"); await run("observe");
    expect((await job()).state).toBe("review"); expect(await hasUnresolvedOrderRestock(db, "soap")).toBe(true);
    expect(writes).toHaveLength(1);
  });
});

describe("回補 HTTP 接收及後台權限", () => {
  it("未明確啟用時，真實接收路徑只觀察並保存訂單，不更新 CRM 或庫存", async () => {
    const response = await app.fetch(new Request("https://test.local/api/webhooks/cyberbiz", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Cyberbiz-Event": "orders/create", Authorization: "Bearer webhook-secret" }, body: JSON.stringify(currentOrder),
    }), runtimeEnv() as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "order", queued: 1 });
    expect(await job()).toMatchObject({ state: "observed", mode: "observe" });
    expect(writes).toHaveLength(0);
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM crm_customers").get()).toEqual({ n: 0 });
  });

  it("未登入與無權限者不能讀取回補明細", async () => {
    await receive(); const row = await job();
    const url = `https://test.local/api/wms/order-restocks/${row.id}`;
    expect((await app.fetch(new Request(url), runtimeEnv() as never)).status).toBe(401);
    expect((await app.fetch(new Request(url, { headers: await authenticatedHeaders([]) }), runtimeEnv() as never)).status).toBe(403);
    const allowed = await app.fetch(new Request(url, { headers: await authenticatedHeaders(["wms:activity:read"]) }), runtimeEnv() as never);
    expect(allowed.status).toBe(200); expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(await allowed.json()).toMatchObject({ orderId: "700", sku: "SOAP" });
  });

  it("只有紀錄讀取權的人不能把回補標成已處理", async () => {
    quantity = 12730; await receive(); await run();
    const row = await job();
    const response = await app.fetch(new Request(`https://test.local/api/wms/order-restocks/${row.id}/resolve`, {
      method: "POST", headers: await authenticatedHeaders(["wms:activity:read"]), body: JSON.stringify({ resolution: "skipped", reason: "確認已人工另行處理" }),
    }), runtimeEnv() as never);
    expect(response.status).toBe(403); expect((await job()).state).toBe("review");
  });

  it("有同步權限可登記人工查核，留下操作者且不呼叫庫存 API", async () => {
    quantity = 12730; await receive(); await run();
    const row = await job();
    const response = await app.fetch(new Request(`https://test.local/api/wms/order-restocks/${row.id}/resolve`, {
      method: "POST", headers: await authenticatedHeaders(["wms:sync:trigger"]), body: JSON.stringify({ resolution: "skipped", reason: "核對調倉單，確認不應回補" }),
    }), runtimeEnv() as never);
    expect(response.status).toBe(200); expect((await job()).state).toBe("skipped"); expect(writes).toHaveLength(0);
  });
});
