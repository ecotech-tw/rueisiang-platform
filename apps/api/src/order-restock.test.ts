import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createInventoryClient, createOrderClient } from "@rueisiang/cyberbiz";
import {
  applySyncPlan, buildSyncPlan, claimCyberbizSyncLock, countItem, createDatabase, dispatchCyberbizWebhook,
  drainOrderRestocks, getOrderRestock, hasUnresolvedOrderRestock, listActivity, listCompanyLinks,
  orderRestockMode, releaseCyberbizSyncLock, resolveOrderRestock, retryFailedCyberbizPushes, syncSystemRoles,
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
let productReads: number;
let onPost: (() => void) | undefined;

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
async function receive(mode: "observe" | "apply" = "apply", payload = currentOrder, topic = "orders/create") {
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
  writes = []; productReads = 0; beforeSecondRead = undefined; onPost = undefined; currentOrder = orderPayload();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/v1/orders/")) {
      if (readFailure) throw new Error("訂單查詢暫時失敗");
      return Response.json(currentOrder);
    }
    if (url.pathname === "/v1/products/100") {
      productReads += 1;
      if (productReads === 2) await beforeSecondRead?.();
      return Response.json({ id: 100, title: "香皂", pos_shop: remotePosId ? { id: remotePosId } : null,
        product_variants: [{ id: 200, sku: "SOAP", inventory_management: managed, inventory_quantity: quantity, safety_inventory_quantity: 5 }],
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
    expect((await job()).state).toBe("pending");
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
