import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import { processCustomerWebhook } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { cyberbizClient } from "../cyberbiz.js";

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

  /** 給人與監控用的探測點：確認這條路由活著、密鑰有沒有設。 */
  .get("/cyberbiz/customers", (c) => {
    return c.json({
      ok: true,
      integration: "CYBERBIZ 會員 webhook",
      configured: Boolean(c.env.CYBERBIZ_WEBHOOK_SECRET),
      events: ["會員註冊", "會員修改", "會員 UID 資料新增", "會員 UID 資料更新", "更新會員標籤"],
    });
  });
