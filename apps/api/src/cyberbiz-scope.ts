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
