/** Worker 的綁定與 secret。wrangler.toml 與 `wrangler secret put` 決定實際內容。 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  AUTH_SESSION_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
}

/**
 * Hono 的型別環境。Bindings 是 Worker 綁定，Variables 是中介層放進 context 的值。
 * 之後 auth 中介層會把已驗證的使用者放進 Variables，讓路由不必重新查一次。
 */
export interface AppEnv {
  Bindings: Env;
}
