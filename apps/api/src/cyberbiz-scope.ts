/**
 * 將店名轉成可放入 NAS object key、且在 runner／Worker 間穩定一致的 scopeId。
 * 店名仍是人看的名稱；AI 查詢使用此 ID，避免中文直接進入 storage key。
 */
export function cyberbizScopeIdFromStoreName(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `store-${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`.slice(0, 100);
}
