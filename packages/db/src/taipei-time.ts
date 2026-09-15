const TAIPEI_TIME_ZONE = "Asia/Taipei";

const TAIPEI_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TAIPEI_TIME_ZONE,
  calendar: "gregory",
});

const TAIPEI_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: TAIPEI_TIME_ZONE,
  calendar: "gregory",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

type TaipeiParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function partsAt(timestamp: number): TaipeiParts {
  const parts = TAIPEI_PARTS_FORMATTER.formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

/** 顯示與日期判斷一律使用 Taipei IANA timezone，不依賴 host timezone。 */
export function formatTaipeiDate(value: Date | number): string {
  return TAIPEI_DATE_FORMATTER.format(typeof value === "number" ? new Date(value) : value);
}

/**
 * 將 Taipei 的 local wall-clock 轉成資料庫使用的 UTC wall-clock 字串。
 * offset 由 IANA timezone 的 round-trip 推導，不依賴 host timezone。
 */
export function taipeiWallClockToUtc(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Taipei timestamp must be YYYY-MM-DD HH:mm:ss");
  const wallClock = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (Number.isNaN(wallClock) || new Date(wallClock).toISOString().slice(0, 19).replace("T", " ") !== value) throw new Error("Taipei timestamp is invalid");

  // Iterate because a timezone transition can change the offset around a boundary.
  let timestamp = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = partsAt(timestamp);
    const observedWallClock = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const correction = observedWallClock - wallClock;
    if (correction === 0) break;
    timestamp -= correction;
  }
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

/** 將 Taipei 日期邊界轉成資料庫使用的 UTC wall-clock 字串。 */
export function taipeiMidnightUtc(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Taipei date must be YYYY-MM-DD");
  return taipeiWallClockToUtc(`${date} 00:00:00`);
}

/** 將 canonical UTC wall-clock timestamp 映射為 Taipei 工作日。 */
export function taipeiDateFromUtcWallClock(value: string): string {
  const normalized = value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? value.slice(0, 10) : formatTaipeiDate(timestamp);
}
