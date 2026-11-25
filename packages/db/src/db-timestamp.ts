/*
 * 資料庫時間欄位的格式是 UTC 的 `YYYY-MM-DD HH:MM:SS`——跟 D1 的 CURRENT_TIMESTAMP 一樣，
 * 也是 taipei-time.ts 換算出來的格式。
 *
 * 舊資料裡還混著 JS `toISOString()` 寫進來的 `YYYY-MM-DDTHH:MM:SS.sssZ`，所以讀的時候兩種都要吃。
 * 沒有時區標記的字串不能直接丟給 `Date`：瀏覽器與 Node 會把它當成執行環境的本地時間。
 * Worker 跑在 UTC 所以看不出來，台北的瀏覽器與本機測試就差 8 小時。
 *
 * 這個檔不 import 任何東西，前端也從 `@rueisiang/db/db-timestamp` 拿同一份。
 */

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * 把資料庫的時間字串轉成 epoch 毫秒；空值或認不得的格式回 `null`。
 * 沒有時區的一律當 UTC；只有日期的當成 UTC 當天 00:00。
 */
export function parseDbTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  if (ZONED.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  const match = WALL_CLOCK.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "0"] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0")));
  // Date.UTC 會把 2 月 30 日滾成 3 月 2 日、61 分滾成下一小時；滾過去就代表原字串無效。
  const check = new Date(timestamp);
  const rolled = check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)
    || check.getUTCHours() !== Number(hour) || check.getUTCMinutes() !== Number(minute) || check.getUTCSeconds() !== Number(second);
  return rolled ? null : timestamp;
}

/** 同 `parseDbTimestamp`，但給要 `Date` 物件的呼叫端（格式化顯示）。 */
export function parseDbDate(value: string | null | undefined): Date | null {
  const timestamp = parseDbTimestamp(value);
  return timestamp === null ? null : new Date(timestamp);
}
