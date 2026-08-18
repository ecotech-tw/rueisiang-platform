/**
 * 電話正規化。搬自舊 CRM 的 lib/crm.ts。
 *
 * 重複判定與搜尋都靠這個結果，所以規則要穩定：去掉所有非數字，
 * 開頭的國碼 886 換回 0（+886912… 與 0912… 是同一支電話）。
 */
export function normalizePhone(value: string): string {
  let digits = value.trim().replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (digits.startsWith("886")) digits = `0${digits.slice(3)}`;
  return digits.replace(/\D/g, "");
}

/** 回傳錯誤訊息，通過則回 null。 */
export function validatePhone(value: string): string | null {
  const normalized = normalizePhone(value);
  if (!normalized) return "請輸入客人電話";
  if (normalized.length < 8 || normalized.length > 15) return "電話格式不正確";
  return null;
}
