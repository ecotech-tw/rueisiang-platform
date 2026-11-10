import {
  createCustomerClient,
  createInventoryClient,
  type CyberbizCustomerClient,
  type CyberbizInventoryClient,
} from "@rueisiang/cyberbiz";
import type { Env } from "./env.js";

/**
 * 從 Worker 的 env 組出 CYBERBIZ client。
 *
 * 沒設 token 就回 undefined 而不是丟錯：webhook 少了它仍然可以用 payload 本身的
 * 內容處理（只是不會回官網重讀），而其他不碰 CYBERBIZ 的功能完全不受影響。
 * 需要 token 才能做的事（例如全量同步）自己檢查。
 */
function cyberbizConfig(env: Env) {
  const relayUrl = env.CYBERBIZ_API_RELAY_URL?.trim();
  const relayToken = env.CYBERBIZ_API_RELAY_TOKEN?.trim();
  if (Boolean(relayUrl) !== Boolean(relayToken)) {
    throw new Error("CYBERBIZ_API_RELAY_URL 與 CYBERBIZ_API_RELAY_TOKEN 必須同時設定。");
  }

  if (relayUrl) {
    const url = new URL(relayUrl);
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const trustedHost = localHost || url.hostname.endsWith(".rueisiang.com");
    if (!trustedHost || (url.protocol !== "https:" && !localHost)
      || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("CYBERBIZ_API_RELAY_URL 必須是受信任的 HTTPS origin。");
    }
  }

  return {
    apiToken: env.CYBERBIZ_API_TOKEN ?? "",
    ...(relayUrl
      ? { baseUrl: relayUrl, relayToken }
      : { baseUrl: env.CYBERBIZ_API_BASE_URL }),
  };
}

export function cyberbizClient(env: Env): CyberbizCustomerClient | undefined {
  if (!env.CYBERBIZ_API_TOKEN) return undefined;
  return createCustomerClient(cyberbizConfig(env));
}

/** 商品庫存的 client。跟會員那支同一個 token，只是打官網的不同區塊。 */
export function cyberbizInventoryClient(env: Env): CyberbizInventoryClient | undefined {
  if (!env.CYBERBIZ_API_TOKEN) return undefined;
  return createInventoryClient(cyberbizConfig(env));
}
