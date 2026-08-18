import { createDatabase } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./env.js";
import { admin } from "./routes/admin.js";
import { auth } from "./routes/auth.js";
import { crm } from "./routes/crm.js";
import { health } from "./routes/health.js";

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
  .route("/crm", crm);

// 打錯的 API 路徑要回 JSON，不要掉進 SPA 的 index.html。
app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }
  console.error(error);
  return c.json({ error: "伺服器發生錯誤。" }, 500);
});

/** 給前端 Hono RPC 用的型別，前後端共用同一份介面定義。 */
export type AppType = typeof routes;

export default app;
