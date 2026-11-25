import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * SQL 裡拿時間欄位比大小或排序時用：兩邊都換成 julianday 再比。
 *
 * 同一欄只要混進一筆帶 `T`、`Z` 的 ISO，直接比字串時空白排在 `T` 前面，同一天裡的先後會
 * 整個顛倒——LINE 佇列的鎖會看起來還沒過期、重置對話之後的新訊息會被當成重置之前。0258 之後
 * 大部分欄位只剩資料庫格式，但有 UPDATE trigger 的表沒轉、比較的另一邊也可能是外部帶進來的
 * ISO，所以會影響行為的比較仍然走這裡。julianday 兩種格式都吃，也保留毫秒。代價是用不到索引，
 * 所以只用在小表或背景清理這種不在乎掃表的查詢。
 */
export function julian(value: AnyColumn | SQL | string): SQL<number> {
  return sql<number>`julianday(${value})`;
}
