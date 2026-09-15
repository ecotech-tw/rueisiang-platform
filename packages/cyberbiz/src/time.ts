const TAIPEI_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Taipei",
  calendar: "gregory",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** CYBERBIZ 未附時區的時間欄位依 API 約定視為 Taipei wall-clock。 */
export function parseTaipeiWallClock(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const wallClock = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (Number.isNaN(wallClock) || new Date(wallClock).toISOString().slice(0, 19).replace("T", " ") !== value) return null;
  let timestamp = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = TAIPEI_PARTS_FORMATTER.formatToParts(new Date(timestamp));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
    const observedWallClock = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    const correction = observedWallClock - wallClock;
    if (correction === 0) break;
    timestamp -= correction;
  }
  return new Date(timestamp);
}
