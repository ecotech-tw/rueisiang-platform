import type { AuthUser } from "@rueisiang/auth";
import type { Database } from "@rueisiang/db";

/** Worker 的綁定與 secret。wrangler.toml 與 `wrangler secret put` 決定實際內容。 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * 倉位現場照片。只存檔案，索引在 zone_images。
   *
   * 沒綁定時上傳會回 503 而不是整個 Worker 起不來——其他功能不該因為沒設定
   * 物件儲存就一起停擺。
   */
  UPLOADS?: R2Bucket;

  AUTH_SESSION_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  /** Gemini generateContent 使用的 API key。Sandbox 沒有設定時會清楚提示管理者。 */
  GEMINI_API_KEY?: string;

  /** CYBERBIZ App Store API 的 token。沒設定時碰到同步相關的功能才會失敗。 */
  CYBERBIZ_API_TOKEN?: string;
  /** 只有測試環境或自架才需要覆寫，預設打正式的 app-store-api。 */
  CYBERBIZ_API_BASE_URL?: string;
  /** 驗證 CYBERBIZ webhook 用。沒設定時那條路由一律回 401。 */
  CYBERBIZ_WEBHOOK_SECRET?: string;

  /*
   * Upstash Redis。快取 CYBERBIZ 的商品目錄，讓「CYBERBIZ 庫存」那一頁不必每次
   * 都去翻幾十頁 API。沿用舊 WMS 的同一個實例——它走的是 REST，Worker 直接打得到。
   *
   * 沒設定時只是變慢：那一頁改成直接問官網，其他功能完全不受影響。
   */
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

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
