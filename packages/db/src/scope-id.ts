/** CYBERBIZ POS 店別在平台、runner 與報表資料之間共用的穩定 scope ID。 */
export function cyberbizScopeIdFromStoreName(name: string): string {
  const bytes = new TextEncoder().encode(name.trim());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `cyberbiz:store:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`.slice(0, 100);
}
