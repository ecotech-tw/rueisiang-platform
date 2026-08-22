import type { AuthUser } from "@rueisiang/auth";
import type { Database } from "@rueisiang/db";
import type { LineAssistantQueueMessage } from "./line-queue.js";

/** Worker 的綁定與 secret。wrangler.toml 與 `wrangler secret put` 決定實際內容。 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** LINE webhook 只負責落地與入列，Pi agent 與 Reply API 在 queue consumer 執行。 */
  LINE_ASSISTANT_QUEUE: Queue<LineAssistantQueueMessage>;
  /** 正式環境一定會綁定；本機 Node server 與不碰 LINE 的測試可以省略。 */
  ASSISTANT_CHAT_AGENT?: DurableObjectNamespace;
  /** 全平台共用一個 credential vault，避免多個 chat 同時旋轉同一支 refresh token。 */
  ASSISTANT_CREDENTIAL_VAULT?: DurableObjectNamespace;
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

  /** Pi Google provider 使用的 API key；Sandbox 與選用 Gemini 的正式 channel 共用。 */
  GEMINI_API_KEY?: string;
  /** 尚未建立 assistant config 時的 LINE fallback；正常情況由後台 active model 決定。 */
  PI_AGENT_MODEL?: string;
  /** Pi 或 Codex CLI 的 ChatGPT OAuth credential JSON；seed fingerprint 改變時會重新灌入 vault。 */
  PI_OPENAI_CODEX_CREDENTIAL?: string;
  /** vault 內 credential 的應用層 AES-GCM encryption key，至少 32 字元。 */
  PI_CREDENTIAL_ENCRYPTION_KEY?: string;
  /** LINE Messaging API 憑證；只由 webhook 與回覆 transport 使用。 */
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  /** 正式環境用來產生後台顯示的 webhook URL；本機未設定時使用 request origin。 */
  PUBLIC_APP_URL?: string;

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
