/*
 * crypto.randomUUID 只在安全連線（HTTPS、localhost）存在；用區網 IP 開 dev server 或某些 App 內建瀏覽器會拿不到，
 * 而報帳表單一打開就要產生送件識別碼。getRandomValues 沒有這個限制。
 */
export function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
