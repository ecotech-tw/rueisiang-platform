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
export function cyberbizClient(env: Env): CyberbizCustomerClient | undefined {
  if (!env.CYBERBIZ_API_TOKEN) return undefined;
  return createCustomerClient({
    apiToken: env.CYBERBIZ_API_TOKEN,
    baseUrl: env.CYBERBIZ_API_BASE_URL,
  });
}

/** 商品庫存的 client。跟會員那支同一個 token，只是打官網的不同區塊。 */
export function cyberbizInventoryClient(env: Env): CyberbizInventoryClient | undefined {
  if (!env.CYBERBIZ_API_TOKEN) return undefined;
  return createInventoryClient({
    apiToken: env.CYBERBIZ_API_TOKEN,
    baseUrl: env.CYBERBIZ_API_BASE_URL,
  });
}
