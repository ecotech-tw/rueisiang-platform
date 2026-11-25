import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * SQL 裡拿時間欄位比大小或排序時用：兩邊都換成 julianday 再比。
 *
 * 舊資料裡同一欄混著 `YYYY-MM-DD HH:MM:SS` 與帶 `T`、`Z` 的 ISO，直接比字串時空白排在 `T`
 * 前面，同一天裡的先後會整個顛倒——LINE 佇列的鎖會看起來還沒過期、重置對話之後的新訊息
 * 會被當成重置之前。julianday 兩種格式都吃，也保留毫秒。代價是用不到索引，所以只用在
 * 小表或背景清理這種不在乎掃表的查詢。
 */
export function julian(value: AnyColumn | SQL | string): SQL<number> {
  return sql<number>`julianday(${value})`;
}
