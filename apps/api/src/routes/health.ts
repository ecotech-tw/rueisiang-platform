import { Hono } from "hono";
import type { AppEnv } from "../env.js";

/**
 * 部署後的煙霧測試端點：確認 Worker 活著，而且 D1 綁定真的接上了。
 * CI 部署完會 curl 這一條。
 */
export const health = new Hono<AppEnv>().get("/", async (c) => {
  let database = "unknown";
  try {
    await c.env.DB.prepare("select 1").first();
    database = "ok";
  } catch (error) {
    database = error instanceof Error ? `fail: ${error.message}` : "fail";
  }

  return c.json({
    status: database === "ok" ? "ok" : "degraded",
    database,
    time: new Date().toISOString(),
  });
});
