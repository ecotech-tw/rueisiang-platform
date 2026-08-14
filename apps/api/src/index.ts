import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { health } from "./routes/health.js";

/**
 * 平台唯一的 Worker：/api/* 由這裡處理，其餘交給 Static Assets（portal 的 SPA）。
 * 路由掛載在 /api 底下，與 wrangler.toml 的 run_worker_first 對齊。
 */
const app = new Hono<AppEnv>().basePath("/api");

const routes = app.route("/health", health);

// 打錯的 API 路徑要回 JSON，不要掉進 SPA 的 index.html。
app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "伺服器發生錯誤。" }, 500);
});

/** 給前端 Hono RPC 用的型別，前後端共用同一份介面定義。 */
export type AppType = typeof routes;

export default app;
