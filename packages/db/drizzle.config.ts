import { defineConfig } from "drizzle-kit";

// D1 是唯一的 schema 方言。舊系統那套「SQLite schema + Postgres 手寫平行 migration」
// 的雙軌維護不再沿用（WMS 已經漂移成 10 vs 4 個 migration）。
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
});
