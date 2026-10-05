import { sql, type AnyColumn, type SQL } from "drizzle-orm";
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

/**
 * 給「ID 清單可能很長」的 IN 查詢用，取代 drizzle 的 `inArray`。
 *
 * `inArray` 每個值佔一個綁定參數，而 D1 單一語句最多 100 個；超過就整句被拒絕。
 * 本機的 node:sqlite 上限是三萬多，所以這種錯只會在正式環境出現、測試測不到。
 * 這裡把整份清單當成一個 JSON 參數交給 `json_each` 展開，清單多長都只佔一個。
 */
export function inJsonArray(column: AnyColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${jsonArrayValues(values)})`;
}

/** 手寫 SQL 裡的 `IN (...)` 用：`WHERE x IN (${jsonArrayValues(ids)})`。理由同 `inJsonArray`。 */
export function jsonArrayValues(values: readonly string[]): SQL {
  return sql`SELECT value FROM json_each(${JSON.stringify(values)})`;
}

/** 多列寫入每列都佔綁定參數，同一個 100 個的上限；一次寫很多列時用它切批。 */
export function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
