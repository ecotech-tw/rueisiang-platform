# 資料庫慣例：時間欄位

本文件說明時間怎麼存、怎麼讀、怎麼比；程式碼是行為的唯一來源。新增資料表（例如會計）時照這裡做，
不要另外發明一套。

## 格式

時間欄位一律是 TEXT，內容是 **UTC** 的 `YYYY-MM-DD HH:MM:SS`，跟 D1 的 `CURRENT_TIMESTAMP` 同一種。

- 欄位預設值用 `` default(sql`CURRENT_TIMESTAMP`) ``，精度到秒。
- 程式寫入用 `toDbTimestamp()`（`packages/db/src/db-timestamp.ts`），多帶毫秒：`2026-11-25 03:00:00.123`。
  同一秒內連寫好幾筆、又要靠時間排順序的地方（小香 Sandbox 的對話）需要毫秒。
- 兩者直接比字串仍然照時間排序：沒有小數的 `CURRENT_TIMESTAMP` 剛好是同一秒的最前面。
- **不要寫 `toISOString()`**。`apps/api/src/db-timestamp-writes.test.ts` 會掃 `packages/db/src` 與
  `apps/api/src`，抓到就紅；只取日期的 `toISOString().slice(0, 10)` 不算。
- 只有日期的欄位（營業日、生效日）存 `YYYY-MM-DD`，欄位名稱不要用 `_at` 結尾。
- 「台北的某一天」換成 UTC 的起訖用 `taipeiMidnightUtc`（`packages/db/src/taipei-time.ts`），
  不要自己加減 8 小時。

外部來源（CYBERBIZ API）給的時間在寫進資料庫那一步用 `normalizeDbTimestamp()` 轉換；
`packages/cyberbiz` 的解析結果維持 ISO，那是 API 的格式。

## 讀與比

沒有時區標記的字串直接丟給 `Date` 會被當成執行環境的本地時間：Worker 跑在 UTC 看不出來，
台北的瀏覽器與本機測試就差 8 小時。

| 要做的事 | 用什麼 |
|---|---|
| 轉成毫秒或 `Date` | `parseDbTimestamp`／`parseDbDate`（前端從 `@rueisiang/db/db-timestamp` 匯入） |
| 顯示台北時間 `YYYY-MM-DD HH:mm` | `taipeiMinuteFromUtcWallClock`（前端從 `@rueisiang/db/taipei-time` 匯入） |
| JS 裡比先後、判斷是不是同一個時間點 | `compareDbTimestamp`、`sameDbTimestamp`，不要用 `<`、`===` 比字串 |
| SQL 裡比大小、排序，而且結果會影響行為 | `julian()`（`packages/db/src/db-time-sql.ts`） |

`julian()` 用不到索引，只用在小表或背景清理。大表的列表排序可以直接用欄位排序，前提是那一欄
只會有一種格式。

## 既有資料

`0258_normalize_timestamps.sql` 把既有的 ISO 值轉成上面的格式（保留毫秒），但**有 UPDATE trigger
的表沒有轉**：D1 關不掉 trigger，已結帳薪資這類守門 trigger 會讓整支 migration 失敗。那些表的時間
本來就由 HR 程式寫成資料庫格式；就算有漏網的 ISO，上面的讀取工具兩種都吃。

小香用重置時間（Sandbox 用 session 建立時間）當對話的 generation，DO 裡存的是當時的字串。
任何改寫這兩欄格式的資料搬移都必須保留到毫秒，否則同一個時間點會被當成較舊的 session、訊息被略過。
