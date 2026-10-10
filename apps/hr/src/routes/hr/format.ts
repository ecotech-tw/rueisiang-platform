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
