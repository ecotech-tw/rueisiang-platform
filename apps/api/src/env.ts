import type { AuthUser } from "@rueisiang/auth";
import type { Database } from "@rueisiang/db";

/** Worker 的綁定與 secret。wrangler.toml 與 `wrangler secret put` 決定實際內容。 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  AUTH_SESSION_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  /** CYBERBIZ App Store API 的 token。沒設定時碰到同步相關的功能才會失敗。 */
  CYBERBIZ_API_TOKEN?: string;
  /** 只有測試環境或自架才需要覆寫，預設打正式的 app-store-api。 */
  CYBERBIZ_API_BASE_URL?: string;
  /** 驗證 CYBERBIZ webhook 用。沒設定時那條路由一律回 401。 */
  CYBERBIZ_WEBHOOK_SECRET?: string;

  /*
   * 出金表。真正的執行在帳務 repo 的 GitHub Actions 上——CYBERBIZ 帳密、Gmail 與
   * Drive 的授權都只存在那邊的 Actions secrets，平台一個都不碰。這裡的 token 是
   * fine-grained PAT，權限僅限那個 repo 的 Actions 讀寫。
   */
  PAYOUT_GITHUB_TOKEN?: string;
  PAYOUT_GITHUB_REPO?: string;
  PAYOUT_WORKFLOW_FILE?: string;
  PAYOUT_GITHUB_REF?: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: Database;
    /** 由 requireAuth 中介層放入，已確認是 active 的帳號。 */
    user: AuthUser;
  };
}
