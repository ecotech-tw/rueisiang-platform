/** 把 YYYY-MM-DD（或以它開頭的時間字串）顯示成 YYYY/M/D；沒有值時顯示 emptyLabel。 */
export function dateLabel(value: string | null | undefined, emptyLabel = "—") {
  if (!value) return emptyLabel;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : value;
}

export function formatHours(minutes: number) {
  return `${(minutes / 60).toFixed(1)} 小時`;
}

/** 資料庫的區間結束日都不含當日；顯示給人看時要退一天。 */
export function dateBefore(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

const taipeiDayFormat = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium" });
const taipeiTimeFormat = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", timeStyle: "short" });

/** API 的時間戳是沒有時區標記的 UTC（`YYYY-MM-DD HH:mm:ss`）；直接丟給 Date 會被當成裝置的本地時間。 */
export function utcStampDate(value: string) {
  return new Date(`${value.replace(" ", "T")}Z`);
}

/** 台北的日期。日期與時間各用一個 formatter，不去切在地化字串——不同 ICU 版本的分隔方式不一樣。 */
export function taipeiDay(value: string) {
  const date = utcStampDate(value);
  return Number.isNaN(date.getTime()) ? value : taipeiDayFormat.format(date);
}

/** 只有時間的區間；結束落在另一天時要講出來，不然 23:00～01:00 看不出跨日。 */
export function taipeiTimeRange(start: string, end: string) {
  const [from, to] = [utcStampDate(start), utcStampDate(end)];
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return `${start}～${end}`;
  return `${taipeiTimeFormat.format(from)}～${taipeiDayFormat.format(from) === taipeiDayFormat.format(to) ? "" : "隔日 "}${taipeiTimeFormat.format(to)}`;
}
