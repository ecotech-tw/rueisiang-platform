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
  /** 同一帳號跨 platform.rueisiang.com／hr.rueisiang.com 時使用，例如 .rueisiang.com。 */
  AUTH_COOKIE_DOMAIN?: string;
  /** 允許前端 app origin，以逗號分隔；未設定時維持同源行為。 */
  AUTH_APP_ORIGINS?: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  /** Google Places API (New) 與 Maps Static API 的後端金鑰；只供 HR 出勤功能使用。 */
  GOOGLE_MAPS_API_KEY?: string;

  /** Pi Google provider 使用的 API key；Sandbox 與選用 Gemini 的正式 channel 共用。 */
  GEMINI_API_KEY?: string;
  /** 尚未建立 assistant config 時的 LINE fallback；正常情況由後台 active model 決定。 */
  PI_AGENT_MODEL?: string;
  /** 舊版 bootstrap 用的 Pi／Codex OAuth credential JSON；vault 已有資料後不再讀取這個 secret。 */
  PI_OPENAI_CODEX_CREDENTIAL?: string;
  /** vault 內 credential 的應用層 AES-GCM encryption key，至少 32 字元。 */
  PI_CREDENTIAL_ENCRYPTION_KEY?: string;
  /** 可選的 NAS Codex relay origin；未設定時維持直接連線 ChatGPT backend。 */
  PI_OPENAI_CODEX_RELAY_URL?: string;
  /** NAS Codex relay 的共享 secret；必須與 relay 同時設定。 */
  PI_OPENAI_CODEX_RELAY_TOKEN?: string;
  /** 私有 NAS storage gateway 的 HTTPS origin；未設定時 WMS 使用既有 R2。 */
  NAS_STORAGE_URL?: string;
  /** 私有 NAS storage gateway 的獨立 shared secret。 */
  NAS_STORAGE_TOKEN?: string;
  /** Shared secret used by the CYBERBIZ runners to import monthly sales and daily payout facts into D1. */
  CYBERBIZ_REPORT_INGEST_TOKEN?: string;
  /** Shared secret used by the read-only CYBERBIZ reports MCP endpoint. */
  CYBERBIZ_REPORT_MCP_TOKEN?: string;
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
   * Upstash Redis。快取 CYBERBIZ 商品目錄與報表查詢結果，讓庫存頁不必每次翻 API，
   * 營運統計也不必重算相同條件。沿用舊 WMS 的同一個實例——它走 REST，Worker 直接打得到。
   *
   * 沒設定時只是變慢：那一頁改成直接問官網，其他功能完全不受影響。
   */
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;

  /*
   * 出金表。真正的執行在帳務 repo 的 GitHub Actions 上——CYBERBIZ 帳密、Gmail 與
   * Drive 的授權都只存在那邊的 Actions secrets，平台一個都不碰。這裡的 token 是
   * fine-grained PAT，供出金表、商品銷售與蝦皮報表共用；只需要各自 repo 的
   * Actions 讀寫。
   */
  GITHUB_TOKEN?: string;
  PAYOUT_GITHUB_REPO?: string;
  PAYOUT_WORKFLOW_FILE?: string;
  PAYOUT_GITHUB_REF?: string;

  /** CYBERBIZ 商品銷售報表 workflow；通常與出金表共用同一個帳務 repo。 */
  CYBERBIZ_SALES_GITHUB_REPO?: string;
  CYBERBIZ_SALES_WORKFLOW_FILE?: string;
  CYBERBIZ_SALES_GITHUB_REF?: string;

  /**
   * 官網對帳單 workflow。跟出金表共用同一個 runner 與 repo，沒設就沿用上面那兩組。
   *
   * 沒有 WORKFLOW_FILE：那支 workflow 就在本 repo 裡，檔名寫死在 shop-report/github.ts。
   */
  CYBERBIZ_SHOP_GITHUB_REPO?: string;
  CYBERBIZ_SHOP_GITHUB_REF?: string;

  /** 蝦皮報表 workflow；平台只暫存檔案並觸發 GitHub Actions。 */
  SHOPEE_GITHUB_REPO?: string;
  SHOPEE_WORKFLOW_FILE?: string;
  SHOPEE_GITHUB_REF?: string;
  /** GitHub runner 下載平台暫存檔案時使用的公開基底網址。 */
  SHOPEE_SOURCE_BASE_URL?: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: Database;
    /** 由 requireAuth 中介層放入，已確認是 active 的帳號。 */
    user: AuthUser;
    /** 由 requireSelfAuth 放入：這次是靠「記住這台手機」而不是 12 小時 session 認出來的。 */
    deviceSession: boolean;
  };
}
