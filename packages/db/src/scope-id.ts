/** CYBERBIZ POS 店別在平台、runner 與報表資料之間共用的穩定 scope ID。 */
export function cyberbizScopeIdFromStoreName(name: string): string {
  const bytes = new TextEncoder().encode(name.trim());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `cyberbiz:store:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`.slice(0, 100);
}

/**
 * scope ID 的字元限制。**不從 ID 推導語意**——來源與種類是 source_type 與
 * scope_kind 兩個欄位的事，前綴只是人看的。這裡只擋掉會讓 URL 與查詢出事的字元。
 */
export function isValidScopeId(scopeId: string): boolean {
  return /^[A-Za-z0-9:_-]{1,100}$/.test(scopeId);
}
