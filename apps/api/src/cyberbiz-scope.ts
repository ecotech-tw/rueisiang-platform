/**
 * 將店名轉成 runner／Worker 間穩定一致且帶有通路前綴的 scopeId。
 * 店名仍是人看的名稱；AI 查詢使用店名，避免讓使用者接觸內部 ID。
 */
export function cyberbizScopeIdFromStoreName(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `cyberbiz:store:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`.slice(0, 100);
}

const MANUAL_SCOPE_PREFIX = "manual:store:";
const MAX_SCOPE_ID_LENGTH = 100;

function hashBytes(bytes: Uint8Array): string {
  let first = 2166136261;
  let second = 2246822519;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 16777619);
    second = Math.imul(second ^ byte, 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * 手動上傳的據點 ID。
 *
 * 退租 POS 的店在 CYBERBIZ 已經不存在，抓不到它的 scopeId，但出金資料還是要進報表。
 * 用 manual: 前綴自成一個通路，不會跟 cyberbiz: 的自動匯入撞在一起；
 * REPORT_STORE_SCOPE_ID 認得這個格式，所以公司總計照樣把它算進去。
 */
export function manualScopeIdFromStoreName(name: string): string {
  const bytes = new TextEncoder().encode(name.trim());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const fullId = `${MANUAL_SCOPE_PREFIX}${encoded}`;
  if (fullId.length <= MAX_SCOPE_ID_LENGTH) return fullId;

  // 長店名不能只截前綴，否則不同店名會共用同一個 scope。
  const suffix = `-${hashBytes(bytes)}`;
  return `${MANUAL_SCOPE_PREFIX}${encoded.slice(0, MAX_SCOPE_ID_LENGTH - MANUAL_SCOPE_PREFIX.length - suffix.length)}${suffix}`;
}
