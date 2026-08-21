import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import { processCustomerWebhook, processProductWebhook } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { forgetCatalog } from "../cyberbiz-catalog.js";
import { cyberbizClient, cyberbizInventoryClient } from "../cyberbiz.js";
import { cacheClient } from "../upstash.js";

/**
 * CYBERBIZ 送進來的 webhook。
 *
 * 這是整個系統唯一不需要登入的寫入端點，所以驗證要嚴：沒設密鑰就一律不收，
 * 驗不過就 401，兩者都不會透露原因。
 *
 * 路徑沿用舊 CRM 的 /api/webhooks/cyberbiz/customers，切換時只要改網域那一段。
 */

/** 2 MB。正常的會員事件遠小於這個，超過的多半是打錯地方。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** topic 可能藏在 body 裡，所以要先 parse——但壞掉的 JSON 交給處理函式去報錯。 */
function safeJson(rawBody: string): unknown {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return {};
  }
}

export const webhooks = new Hono<AppEnv>()
  .post("/cyberbiz/customers", async (c) => {
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

    let payload: unknown = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON payload" });
    }

    const topic = readCyberbizTopic(c.req.raw, payload);
    const outcome = await processCustomerWebhook(c.get("db"), {
      rawBody,
      topic,
      client: cyberbizClient(c.env),
    });

    return c.json(outcome);
  })

  /**
   * 商品／庫存事件。訂閱的是 CYBERBIZ 的 `variants/update`。
   *
   * 跟會員分成兩條路，不是一條路裡面分流：兩者的處理完全不同（一邊寫客戶、一邊
   * 寫庫存），落地的表不同，補跑的方式也不同。合成一條的話每次改其中一邊都要
   * 重新確認沒有影響另一邊。
   *
   * 沒有這條路的時候，官網改了數量要等人按「同步到庫存」平台才知道——倉庫的人
   * 看到的是一個安靜地過期的數字。
   */
  .post("/cyberbiz/inventory", async (c) => {
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

    const topic = readCyberbizTopic(c.req.raw, safeJson(rawBody));
    const outcome = await processProductWebhook(c.get("db"), {
      rawBody,
      topic,
      client: cyberbizInventoryClient(c.env),
    });

    /*
     * 官網那邊的數字動了，快取的目錄就過期了——「CYBERBIZ 庫存」那一頁最多會
     * 有一整天顯示舊數量。跟盤點推上去之後同一個道理。
     */
    if (outcome.status === "processed") await forgetCatalog(cacheClient(c.env));

    /*
     * 處理失敗也回 200。
     *
     * 事件已經落地了，補跑歸我們自己的 cron 管——回 5xx 只會讓 CYBERBIZ 用掉
     * 重送次數，用完之後那筆事件就真的消失了，而我們手上其實還留著它。
     */
    return c.json(outcome);
  })

  .get("/cyberbiz/inventory", (c) => {
    return c.json({
      ok: true,
      integration: "CYBERBIZ 商品庫存 webhook",
      configured: Boolean(c.env.CYBERBIZ_WEBHOOK_SECRET),
      events: ["商品款式更新（variants/update）"],
    });
  })

  /** 給人與監控用的探測點：確認這條路由活著、密鑰有沒有設。 */
  .get("/cyberbiz/customers", (c) => {
    return c.json({
      ok: true,
      integration: "CYBERBIZ 會員 webhook",
      configured: Boolean(c.env.CYBERBIZ_WEBHOOK_SECRET),
      events: ["會員註冊", "會員修改", "會員 UID 資料新增", "會員 UID 資料更新", "更新會員標籤"],
    });
  });
