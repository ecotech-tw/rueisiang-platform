import { OVERTIME_UNIT_MINUTES, parseHours } from "@rueisiang/ui";

/** 後端請假區間最長 31 天；再大的數字換算不出有意義的結束時間，還會把日期推出可表示的範圍。 */
const MAX_MINUTES = 31 * 24 * 60;

/** 時數欄位的文字轉成分鐘；不是 0.5 小時的正倍數、或超過 31 天就回 null。 */
export function hoursToMinutes(text: string) {
  const minutes = parseHours(text);
  return minutes !== null && minutes >= OVERTIME_UNIT_MINUTES && minutes <= MAX_MINUTES && minutes % OVERTIME_UNIT_MINUTES === 0 ? minutes : null;
}
