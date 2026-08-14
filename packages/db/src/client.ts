import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDatabase>;

/**
 * 唯一的 DB 進入點。傳入 Worker 的 D1 綁定即可。
 *
 * 這裡刻意沒有舊系統那種「D1 介面 + Postgres 墊片」的雙後端設計
 * （CRM/WMS 的 getD1() 會回傳一個假裝成 D1 的 pg.Pool，連 ? → $1 都自己 replace）。
 * 只有一個後端就不需要墊片，也不會有兩套 migration 漂移的問題。
 */
export function createDatabase(d1: D1Database) {
  return drizzle(d1, { schema, casing: "snake_case" });
}
