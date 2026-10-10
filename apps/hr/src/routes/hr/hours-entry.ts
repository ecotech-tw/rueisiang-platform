/** 與後端請假、加班的最小單位相同；畫面先擋，使用者才不用送出後才知道。 */
const UNIT_MINUTES = 30;

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 時數欄位的文字轉成分鐘；不是 0.5 小時的正倍數就回 null。 */
export function hoursToMinutes(text: string) {
  const minutes = text.trim() ? Number(text) * 60 : NaN;
  return Number.isFinite(minutes) && minutes >= UNIT_MINUTES && minutes % UNIT_MINUTES === 0 ? minutes : null;
}

export function minutesToHours(minutes: number) {
  return String(Math.round((minutes / 60) * 100) / 100);
}

/** 借 UTC 做進位而已：台北沒有日光節約，本地時間加減分鐘不會有落差。 */
export function addMinutes(value: string, minutes: number) {
  const timestamp = LOCAL_DATE_TIME.test(value) ? Date.parse(`${value}:00Z`) : NaN;
  return Number.isNaN(timestamp) ? "" : new Date(timestamp + minutes * 60_000).toISOString().slice(0, 16);
}
