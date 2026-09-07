import { cyberbizScopeIdFromStoreName } from "@rueisiang/db";

export { cyberbizScopeIdFromStoreName };

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

/**
 * 傳給 runner 的店別設定。
 *
 * 舊版是把這份清單 commit 成 tools/cyberbiz-reports/stores.json，讓 runner 從
 * checkout 出來的檔案讀——同一份資料存在 D1、stores.json、config.json 三個地方，
 * 改了其中一個另外兩個不會跟著動。改成跟著每一次 dispatch 傳過去之後，D1 就是
 * 唯一來源，而且 GITHUB_TOKEN 也不再需要 Contents 寫入權限。
 *
 * scopeId 一起帶過去：runner 舊版是自己從店名算（base64url），等於同一條規則
 * 寫在兩個 repo 的兩個語言裡。
 */
export function runnerStores(stores: Array<{ id?: string; scopeId?: string; name: string; driveFolderUrl: string; driveFolderName: string }>) {
  return stores.map(({ id, scopeId, name, driveFolderUrl, driveFolderName }) => ({
    scopeId: scopeId ?? id ?? cyberbizScopeIdFromStoreName(name),
    name,
    driveFolderUrl,
    driveFolderName,
  }));
}
