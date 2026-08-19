import { CyberbizApiError } from "@rueisiang/cyberbiz";
import { createDatabase, retryFailedWebhooks } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import { cyberbizClient } from "./cyberbiz.js";
import type { AppEnv, Env } from "./env.js";
import { admin } from "./routes/admin.js";
import { auth } from "./routes/auth.js";
import { crm } from "./routes/crm.js";
import { webhooks } from "./routes/webhooks.js";
import { health } from "./routes/health.js";
import { PayoutGithubError } from "./payout/github.js";
import { tools } from "./routes/tools.js";

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
  .route("/crm", crm)
  .route("/tools", tools)
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
      console.error("CYBERBIZ 憑證被拒絕", error.message);
      return c.json({ error: "平台與 CYBERBIZ 的憑證有問題，請聯絡管理者確認 API token。" }, 502);
    }
    if (error.status >= 400 && error.status < 500) {
      return c.json({ error: `CYBERBIZ：${error.message.replace(/^CYBERBIZ API \d+: /, "")}` }, error.status as 400);
    }
    console.error(error);
    return c.json({ error: "CYBERBIZ 暫時無法回應，請稍後再試。" }, 502);
  }

  // 同理，GitHub 拒絕觸發時要說得出是憑證問題還是別的，不然沒人查得下去。
  if (error instanceof PayoutGithubError) {
    console.error("GitHub Actions 觸發失敗", error.message);
    return c.json({ error: error.message }, 502);
  }

  console.error(error);
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

  // waitUntil：讓 Cron 的回應先結束，補跑在背景完成。
  ctx.waitUntil(
    retryFailedWebhooks(db, { client: cyberbizClient(env) })
      .then((result) => {
        if (result.attempted) console.log("補跑失敗的 webhook", result);
      })
      .catch((error) => console.error("補跑失敗的 webhook 時出錯", error)),
  );
}

export default { fetch: app.fetch, scheduled };
