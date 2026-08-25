import { CyberbizApiError } from "@rueisiang/cyberbiz";
import { assistantErrorDetails, assistantLog } from "@rueisiang/assistant";
import {
  WmsError,
  createDatabase,
  deleteMediaObject,
  listExpiredMediaObjects,
  retryFailedProductWebhooks,
  retryFailedWebhooks,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import { forgetCatalog } from "./cyberbiz-catalog.js";
import { cyberbizClient, cyberbizInventoryClient } from "./cyberbiz.js";
import { cacheClient } from "./upstash.js";
import { NasStorageConfigError, NasStorageError, nasStorageClient } from "./nas-storage.js";
import type { AppEnv, Env } from "./env.js";
import { admin } from "./routes/admin.js";
import { assistant } from "./routes/assistant.js";
import { auth } from "./routes/auth.js";
import { crm } from "./routes/crm.js";
import { drainLineAssistantQueueOutbox, processLineAssistantQueueMessage, webhooks } from "./routes/webhooks.js";
import { health } from "./routes/health.js";
import { PayoutGithubError } from "./payout/github.js";
import { ShopeeSalesGithubError } from "./shopee-sales/github.js";
import { tools } from "./routes/tools.js";
import { shopeeSalesInternal } from "./routes/shopee-sales-internal.js";
import { wms } from "./routes/wms.js";
import type { LineAssistantQueueMessage } from "./line-queue.js";
export { AssistantChatAgent } from "./pi-agent-do.js";
export { AssistantCredentialVault } from "./pi-agent-credentials.js";

/**
 * 平台唯一的 Worker：/api/* 由這裡處理，其餘交給 Static Assets（portal 的 SPA）。
 * 路由掛在 /api 底下，與 wrangler.toml 的 run_worker_first 對齊。
 */
const app = new Hono<AppEnv>().basePath("/api");

const withDatabase = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDatabase(c.env.DB));
  await next();
});

app.use("*", withDatabase);

const routes = app
  .route("/health", health)
  .route("/auth", auth)
  .route("/admin", admin)
  .route("/assistant", assistant)
  .route("/crm", crm)
  .route("/internal/shopee-sales", shopeeSalesInternal)
  .route("/tools", tools)
  .route("/wms", wms)
  .route("/webhooks", webhooks);

// 打錯的 API 路徑要回 JSON，不要掉進 SPA 的 index.html。
app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }

  /*
   * CYBERBIZ 的錯誤要照原樣讓人看到，不要一律變成「伺服器發生錯誤」。
   * 官網回「這支手機已存在」時，使用者需要看到的是那句話，而不是我們吞掉之後
   * 的一句廢話——他改一下電話就能繼續，看到 500 只會來問是不是壞了。
   */
  if (error instanceof CyberbizApiError) {
    if (error.status === 401 || error.status === 403) {
      // 這是我們的 token 有問題，不是使用者送錯東西。
      assistantLog("error", "cyberbiz.auth_failed", {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        error: assistantErrorDetails(error),
      });
      return c.json({ error: "平台與 CYBERBIZ 的憑證有問題，請聯絡管理者確認 API token。" }, 502);
    }
    if (error.status >= 400 && error.status < 500) {
      return c.json({ error: `CYBERBIZ：${error.message.replace(/^CYBERBIZ API \d+: /, "")}` }, error.status as 400);
    }
    assistantLog("error", "cyberbiz.request_failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: assistantErrorDetails(error),
    });
    return c.json({ error: "CYBERBIZ 暫時無法回應，請稍後再試。" }, 502);
  }

  /*
   * 倉儲的錯誤自己帶著「是哪一種」。全部回 500 的話，「這個倉位還有商品」
   * 會被前端當成系統故障重試，但那是使用者要自己處理的事，重試幾次都一樣。
   */
  if (error instanceof WmsError) {
    const status = error.kind === "not_found" ? 404 : error.kind === "conflict" ? 409 : 400;
    return c.json({ error: error.message }, status);
  }

  // 同理，GitHub 拒絕觸發時要說得出是憑證問題還是別的，不然沒人查得下去。
  if (error instanceof PayoutGithubError) {
    assistantLog("error", "payout.github_trigger_failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: assistantErrorDetails(error),
    });
    return c.json({ error: error.message }, 502);
  }

  if (error instanceof ShopeeSalesGithubError) {
    assistantLog("error", "shopee.github_trigger_failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: assistantErrorDetails(error),
    });
    return c.json({ error: error.message }, 502);
  }

  assistantLog("error", "http.error", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    error: assistantErrorDetails(error),
  });
  return c.json({ error: "伺服器發生錯誤。" }, 500);
});

/** 給前端 Hono RPC 用的型別，前後端共用同一份介面定義。 */
export type AppType = typeof routes;

/**
 * 定時工作。
 *
 * 取代舊 CRM 那個「前端每 15 秒打一次 drain」的輪詢——那要有人開著分頁才會動，
 * 關掉瀏覽器同步就停了。改成伺服器端固定跑，跟誰有沒有登入無關。
 *
 * 目前只做一件事：補跑處理失敗的 webhook。全量同步仍然是手動觸發，
 * 因為它會打很多次官網 API，不該在沒人看著的時候自己跑起來。
 */
async function scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const db = createDatabase(env.DB);

  ctx.waitUntil(
    cleanupExpiredMedia(env, db)
      .catch((error) => assistantLog("error", "media.expiry_cleanup_failed", {
        error: assistantErrorDetails(error),
      })),
  );

  // waitUntil：讓 Cron 的回應先結束，補跑在背景完成。
  ctx.waitUntil(
    retryFailedWebhooks(db, { client: cyberbizClient(env) })
      .then((result) => {
        if (result.attempted) assistantLog("info", "scheduled.crm_webhook_retry", result);
      })
      .catch((error) => assistantLog("error", "scheduled.crm_webhook_retry_failed", {
        error: assistantErrorDetails(error),
      })),
  );

  // 商品那條分開跑：兩者互不相干，一邊掛掉不該連累另一邊。
  ctx.waitUntil(
    retryFailedProductWebhooks(db, { client: cyberbizInventoryClient(env) })
      .then(async (result) => {
        if (result.attempted) assistantLog("info", "scheduled.product_webhook_retry", result);
        /*
         * 補跑改到庫存的話，快取的目錄一樣過期了。這條路不經過 webhook 路由，
         * 所以要自己清一次——不清的話畫面上的數字會一直舊到 TTL 到期。
         */
        if (result.processed) await forgetCatalog(cacheClient(env));
      })
      .catch((error) => assistantLog("error", "scheduled.product_webhook_retry_failed", {
        error: assistantErrorDetails(error),
      })),
  );

  ctx.waitUntil(
    drainLineAssistantQueueOutbox(db, env)
      .catch((error) => assistantLog("error", "line.queue.outbox_drain_failed", {
        error: assistantErrorDetails(error),
      })),
  );
}

async function cleanupExpiredMedia(env: Env, db: ReturnType<typeof createDatabase>): Promise<void> {
  const nas = nasStorageClient(env);
  if (!nas) return;
  const expired = await listExpiredMediaObjects(db);
  let removed = 0;
  let failed = 0;
  for (const media of expired) {
    try {
      await nas.delete(media.objectKey);
      await deleteMediaObject(db, media.objectKey);
      removed += 1;
    } catch (error) {
      failed += 1;
      assistantLog("warn", "media.expiry_cleanup_item_failed", {
        objectKey: media.objectKey,
        error: assistantErrorDetails(error),
      });
    }
  }
  if (removed || failed) assistantLog("info", "media.expiry_cleanup", { removed, failed });
}

async function queue(batch: MessageBatch<LineAssistantQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processLineAssistantQueueMessage(message.body, env);
      message.ack();
    } catch (error) {
      assistantLog("warn", "line.queue.consumer_retry", {
        messageId: message.id,
        attempts: message.attempts,
        kind: message.body.kind,
        runId: message.body.kind === "assistant" ? message.body.runId : null,
        webhookEventId: message.body.webhookEventId,
        channelKey: message.body.channelKey,
        groupId: message.body.lineGroupId,
        error: assistantErrorDetails(error),
      });
      message.retry();
    }
  }
}

export default { fetch: app.fetch, scheduled, queue } satisfies ExportedHandler<Env, LineAssistantQueueMessage>;
