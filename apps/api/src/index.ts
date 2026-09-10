import { CyberbizApiError } from "@rueisiang/cyberbiz";
import { SESSION_COOKIE, readCookie } from "@rueisiang/auth";
import { assistantErrorDetails, assistantLog } from "@rueisiang/assistant";
import {
  WmsError,
  createDatabase,
  deleteMediaObject,
  listExpiredMediaObjects,
  purgeSettledWebhookEvents,
  retryFailedProductWebhooks,
  retryFailedCyberbizPushes,
  retryFailedWebhooks,
  syncCyberbizProducts,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import { forgetCatalog, loadCatalog } from "./cyberbiz-catalog.js";
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
import { hr } from "./routes/hr.js";
import { items } from "./routes/items.js";
import { PayoutGithubError } from "./payout/github.js";
import { ShopeeSalesGithubError } from "./shopee-sales/github.js";
import { tools } from "./routes/tools.js";
import { CyberbizSalesGithubError } from "./cyberbiz-sales/github.js";
import { cyberbizReports } from "./routes/cyberbiz-reports.js";
import { shopeeSalesInternal } from "./routes/shopee-sales-internal.js";
import { cyberbizReportsInternal } from "./routes/cyberbiz-reports-internal.js";
import { cyberbizReportsMcp } from "./routes/cyberbiz-reports-mcp.js";
import { wms } from "./routes/wms.js";
import type { LineAssistantQueueMessage } from "./line-queue.js";
export { AssistantChatAgent } from "./pi-agent-do.js";
export { AssistantCredentialVault } from "./pi-agent-credentials.js";

/**
 * API Worker：/api/* 由這裡處理；platform 的 Static Assets 由同一 Worker 提供。
 * hr app 以獨立靜態站部署，透過 CORS 與這裡共用 session。
 */
const app = new Hono<AppEnv>().basePath("/api");

function allowedOrigins(raw: string | undefined): string[] {
  const configured = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  return configured.length ? configured : [
    "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
    "http://localhost:5176", "http://localhost:5177", "http://localhost:5178", "http://localhost:5182",
    "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175",
    "http://127.0.0.1:5176", "http://127.0.0.1:5177", "http://127.0.0.1:5178", "http://127.0.0.1:5182",
  ];
}

function sameAllowedOrigin(value: string | undefined, origins: string[]): boolean {
  if (!value) return false;
  try {
    return origins.includes(new URL(value).origin);
  } catch {
    return false;
  }
}

app.use("*", async (c, next) => {
  const origins = allowedOrigins(c.env.AUTH_APP_ORIGINS);
  const origin = c.req.header("Origin");
  if (origin && !origins.includes(origin)) return c.json({ error: "Origin not allowed" }, 403);
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
    c.header("Vary", "Origin");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);

  const isUnsafeMethod = !["GET", "HEAD"].includes(c.req.method);
  const hasSession = Boolean(readCookie(c.req.header("Cookie"), SESSION_COOKIE));
  if (c.env.AUTH_COOKIE_DOMAIN && isUnsafeMethod && hasSession && !origin && !sameAllowedOrigin(c.req.header("Referer"), origins)) {
    return c.json({ error: "需要有效的請求來源。" }, 403);
  }
  return next();
});

const withDatabase = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDatabase(c.env.DB));
  await next();
});

app.use("*", withDatabase);

const routes = app
  .route("/health", health)
  .route("/auth", auth)
  .route("/admin", admin)
  .route("/hr", hr)
  .route("/assistant", assistant)
  .route("/crm", crm)
  .route("/internal/shopee-sales", shopeeSalesInternal)
  .route("/internal/cyberbiz-reports", cyberbizReportsInternal)
  .route("/mcp/cyberbiz-reports", cyberbizReportsMcp)
  .route("/tools", tools)
  .route("/reports/cyberbiz", cyberbizReports)
  .route("/items", items)
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

  if (error instanceof CyberbizSalesGithubError) {
    assistantLog("error", "cyberbiz.sales.github_trigger_failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: assistantErrorDetails(error),
    });
    return c.json({ error: error.message }, 502);
  }

  if (error instanceof NasStorageConfigError) {
    assistantLog("error", "nas_storage.configuration_failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: assistantErrorDetails(error),
    });
    return c.json({ error: error.message }, 503);
  }

  if (error instanceof NasStorageError) {
    assistantLog("error", "nas_storage.request_failed", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: error.status,
      code: error.code,
      retryable: error.retryable,
      error: assistantErrorDetails(error),
    });
    return c.json(
      { error: error.retryable ? "NAS 儲存服務暫時無法使用，請稍後再試。" : "NAS 儲存服務拒絕了這次請求。" },
      error.retryable ? 503 : 502,
    );
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

  /*
   * webhook 事件只進不出：官網每改一次會員或商品就多一列，而它的用途只有
   * 「這一筆處理過了嗎」與「失敗的要補跑」，兩者都只看得到最近的資料。
   * 只清 processed 與 ignored——failed 是還沒解決的問題，清掉就沒人會發現它。
   */
  ctx.waitUntil(
    purgeSettledWebhookEvents(db)
      .then((result) => {
        if (result.deleted) assistantLog("info", "scheduled.webhook_event_purge", result);
      })
      .catch((error) => assistantLog("error", "scheduled.webhook_event_purge_failed", {
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

  // 盤點推送失敗不是 webhook，不能只靠上面的 webhook retry；用 activity log
  // 找出尚未被成功事件覆蓋的 item，重新讀官網後以 absolute target reconcile。
  ctx.waitUntil(
    retryFailedCyberbizPushes(db, cyberbizInventoryClient(env))
      .then(async (result) => {
        if (result.attempted) assistantLog("info", "scheduled.cyberbiz_push_retry", result);
        if (result.recovered) await forgetCatalog(cacheClient(env));
      })
      .catch((error) => assistantLog("error", "scheduled.cyberbiz_push_retry_failed", {
        error: assistantErrorDetails(error),
      })),
  );

  /*
   * 報表的商品身分來自 cyberbiz_products 鏡像，所以它必須自己會更新。
   *
   * 商品目錄鏡像不能依賴人工打開某個頁面，不然新商品上架後的月匯入會不會漏掉它，
   * 取決於剛好有沒有人觸發目錄查詢。
   */
  ctx.waitUntil(
    mirrorCyberbizCatalog(env, db)
      .then((result) => {
        if (result) assistantLog("info", "scheduled.cyberbiz_catalog_mirror", result);
      })
      .catch((error) => assistantLog("error", "scheduled.cyberbiz_catalog_mirror_failed", {
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

/**
 * 把官網目錄同步進 D1 鏡像。
 *
 * truncated（官網還有沒翻完的頁）時照樣寫已經拿到的部分，但記進 log：鏡像不完整會讓
 * 匯入靜默略過商品，那不該只能靠事後對數字才發現。
 */
async function mirrorCyberbizCatalog(
  env: Env,
  db: ReturnType<typeof createDatabase>,
): Promise<{ synced: number; truncated: boolean } | null> {
  const client = cyberbizInventoryClient(env);
  if (!client) return null;
  const catalog = await loadCatalog(client, cacheClient(env));
  const { synced } = await syncCyberbizProducts(db, catalog.items);
  return { synced, truncated: catalog.truncated };
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
