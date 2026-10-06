import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/*
 * D1 單一語句最多 100 個綁定參數。清單型的查詢與多列寫入都會碰到，這個檔案放繞過它的三個工具。
 * 本機的 D1 替身（apps/api/src/local-d1/d1.ts）照同一個上限擋，所以漏用的地方測試會紅。
 */

/**
 * 給「長度不受控的 ID 清單」的 IN 查詢用，取代 drizzle 的 `inArray`。
 *
 * `inArray` 每個值佔一個綁定參數，超過上限整句被拒絕。這裡把整份清單當成一個 JSON 參數
 * 交給 `json_each` 展開，清單多長都只佔一個。
 *
 * 固定幾個字面值的清單（狀態、事件種類）繼續用 `inArray`：參數數量是固定的，
 * 而且 `inArray` 會照欄位的 enum 檢查型別，打錯字 typecheck 就會擋；這裡只收 string[]。
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
