import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import { dispatchCyberbizWebhook } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { forgetCatalog } from "../cyberbiz-catalog.js";
import { cyberbizClient, cyberbizInventoryClient } from "../cyberbiz.js";
import type { AppEnv, Env } from "../env.js";
import { cacheClient } from "../upstash.js";
import type { Context } from "hono";

/**
 * CYBERBIZ 送進來的 webhook。**一個網址收全部的事件。**
 *
 * 這是整個系統唯一不需要登入的寫入端點，所以驗證要嚴：沒設密鑰就一律不收，
 * 驗不過就 401，兩者都不會透露原因。
 *
 * 為什麼不是每種事件一個網址：CYBERBIZ 後台的訂閱是人手動設的，每多一個網址就
 * 多一個「有沒有設到」的問題，而設漏了不會有任何錯誤訊息——只會安靜地不同步。
 * 分派在程式裡做（見 packages/db 的 dispatchCyberbizWebhook），那段判斷本來就
 * 跑不掉：CYBERBIZ 不一定送 topic 標頭，就算分成好幾條路，每一條也還是得驗證
 * 自己收到的是不是該收的。
 */

/** 2 MB。正常的事件遠小於這個，超過的多半是打錯地方。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** parse 不出來時回這個。用 Symbol 才不會跟「payload 本身就是 null」混淆。 */
const MALFORMED = Symbol("malformed-json");

/** topic 可能藏在 body 裡，所以分派前要先 parse 一次。 */
function safeJson(rawBody: string): unknown {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return MALFORMED;
  }
}

async function receive(c: Context<AppEnv>) {
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "Payload too large" });
  }

  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "Payload too large" });
  }

  const verified = await verifyCyberbizWebhook(
    c.req.raw,
    rawBody,
    c.env.CYBERBIZ_WEBHOOK_SECRET ?? "",
  );
  if (!verified) throw new HTTPException(401, { message: "Invalid webhook signature or token" });

  /*
   * 壞掉的 JSON 在這裡就擋下來，回 400。
   *
   * 讓它進到分派再由處理函式丟錯的話會變成 500——那是在說「我們壞了」，但實際上
   * 是對方送了壞東西。而且 5xx 會讓 CYBERBIZ 重送，重送一份一樣壞的內容沒有意義。
   */
  const payload = safeJson(rawBody);
  if (payload === MALFORMED) {
    throw new HTTPException(400, { message: "Invalid JSON payload" });
  }

  const outcome = await dispatchCyberbizWebhook(c.get("db"), {
    rawBody,
    topic: readCyberbizTopic(c.req.raw, payload),
    customerClient: cyberbizClient(c.env),
    inventoryClient: cyberbizInventoryClient(c.env),
  });

  /*
   * 官網那邊的庫存動了，快取的目錄就過期了——「CYBERBIZ 庫存」那一頁最多會有
   * 一整天顯示舊數量。跟盤點推上去之後同一個道理。
   */
  if (outcome.kind === "product" && outcome.status === "processed") {
    await forgetCatalog(cacheClient(c.env));
  }

  /*
   * 處理失敗也回 200。
   *
   * 事件已經落地了，補跑歸我們自己的 cron 管——回 5xx 只會讓 CYBERBIZ 用掉
   * 重送次數，用完之後那筆事件就真的消失了，而我們手上其實還留著它。
   */
  return c.json(outcome);
}

/** 給人與監控用的探測點：確認這條路由活著、密鑰有沒有設。 */
function probe(c: Context<AppEnv>) {
  return c.json({
    ok: true,
    integration: "CYBERBIZ webhook",
    configured: Boolean((c.env as Env).CYBERBIZ_WEBHOOK_SECRET),
    events: [
      "會員註冊、會員修改、會員 UID 資料新增／更新、更新會員標籤",
      "商品款式更新（variants/update）",
    ],
  });
}

export const webhooks = new Hono<AppEnv>()
  /** 正式網址。CYBERBIZ 後台的所有事件都設到這裡。 */
  .post("/cyberbiz", receive)
  .get("/cyberbiz", probe)

  /*
   * 舊網址，**不要移除**。
   *
   * 它是搬進平台時就設在 CYBERBIZ 後台的那一個，改成 /cyberbiz 之後仍然會有
   * 事件從這裡進來——後台改設定與程式部署不可能同一秒發生，而且以後也可能有
   * 沒改到的地方。收到就照樣處理，比讓事件掉在地上好。
   */
  .post("/cyberbiz/customers", receive)
  .get("/cyberbiz/customers", probe);
