/*
 * 資料庫時間欄位的格式是 UTC 的 `YYYY-MM-DD HH:MM:SS`——跟 D1 的 CURRENT_TIMESTAMP 一樣，
 * 也是 taipei-time.ts 換算出來的格式。程式寫入的用 `toDbTimestamp`，多帶毫秒 `.SSS`：
 * 小香 Sandbox 這類同一秒內連寫好幾筆的地方要靠毫秒排順序。沒有小數的 CURRENT_TIMESTAMP
 * 剛好是同一秒的最前面，所以兩者直接拿字串比大小仍然對。
 *
 * 舊資料裡還混著 JS `toISOString()` 寫進來的 `YYYY-MM-DDTHH:MM:SS.sssZ`，所以讀的時候兩種都要吃。
 * 沒有時區標記的字串不能直接丟給 `Date`：瀏覽器與 Node 會把它當成執行環境的本地時間。
 * Worker 跑在 UTC 所以看不出來，台北的瀏覽器與本機測試就差 8 小時。
 *
 * 這個檔不 import 任何東西，前端也從 `@rueisiang/db/db-timestamp` 拿同一份。
 */

/** 寫進資料庫的時間一律用這個產生，不要寫 `toISOString()`。 */
export function toDbTimestamp(value: Date | number = Date.now()): string {
  return new Date(value).toISOString().slice(0, 23).replace("T", " ");
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:\d{2})?)?$/i;

/**
 * 把資料庫的時間字串轉成 epoch 毫秒；空值或認不得的格式回 `null`。
 * 沒有時區的一律當 UTC；只有日期的當成 UTC 當天 00:00。
 *
 * 帶時區的也自己拆，不交給 `Date.parse`：V8 會把 `2026-02-30T00:00:00Z` 默默滾成 3/2。
 */
export function parseDbTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "0", zone = "Z"] = match;
  const wallClock = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0")));
  // Date.UTC 會把 2 月 30 日滾成 3 月 2 日、61 分滾成下一小時；滾過去就代表原字串無效。
  const check = new Date(wallClock);
  const rolled = check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day)
    || check.getUTCHours() !== Number(hour) || check.getUTCMinutes() !== Number(minute) || check.getUTCSeconds() !== Number(second);
  if (rolled) return null;
  if (zone.toUpperCase() === "Z") return wallClock;
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(4, 6));
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  return wallClock - offset;
}

/**
 * 外部來源（CYBERBIZ）給的時間轉成資料庫格式。認不得的原樣回傳，空字串還是空字串——
 * 呼叫端靠 `||` 決定要不要沿用舊值，這裡不能把空值變成別的東西。
 */
export function normalizeDbTimestamp(value: string): string;
export function normalizeDbTimestamp(value: string | null): string | null;
export function normalizeDbTimestamp(value: string | null): string | null {
  const timestamp = parseDbTimestamp(value);
  return timestamp === null ? value : toDbTimestamp(timestamp);
}

/** 兩個時間字串是不是同一個時間點；格式不同（舊資料的 ISO）也算同一個。認不得的就比字串。 */
export function sameDbTimestamp(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === b) return true;
  const left = parseDbTimestamp(a);
  return left !== null && left === parseDbTimestamp(b);
}

/** 同 `parseDbTimestamp`，但給要 `Date` 物件的呼叫端（格式化顯示）。 */
export function parseDbDate(value: string | null | undefined): Date | null {
  const timestamp = parseDbTimestamp(value);
  return timestamp === null ? null : new Date(timestamp);
}
