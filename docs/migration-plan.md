# 瑞香內部系統整合平台 — 初始化與遷移計畫

## Context

瑞香目前有四套獨立系統，全部是同一個 Next.js 模板長出來的拷貝：

| 系統 | repo / 位置 | 規模 | 現況 |
|---|---|---|---|
| CRM | `ecotech-tw/rueisiang-crm` | 6 張表、42 commits | Cloud Run + Cloud SQL；另有一條 Cloudflare D1 部署 |
| WMS | `ecotech-tw/rueisiang-wms` | 10 張表、63 commits | Cloud Run + **同一個** Cloud SQL instance |
| CYBERBIZ webhook relay | `cyberbiz-webhook-relay/` | 小 | 活的（CRM 每 15 秒 poll 它） |
| 出金表工具 | `.claude/skills/cyberbiz-monthly-payout/` | 小 | Cloudflare Worker → GitHub Actions |

問題不在於哪一套寫得不好，而在於**它們是四份會各自演化的拷貝**。同名的共用檔案已經分歧：`auth-session.ts` 差 263 行、`cyberbiz-webhook.ts` 差 238 行、`google-oauth.ts` 差 169 行、`runtime-env.ts` 差 49 行。兩套系統各有一份獨立的 `app_users`，各自實作了一次 `admin|viewer`。CYBERBIZ API client 有三份（CRM `lib/cyberbiz.ts` 12.6KB、WMS `lib/cyberbiz-inventory.ts` 29.5KB、relay 一份）。

**時機正確**：兩個 repo 都只有一個月大、加起來 105 個 commit，分歧還只有幾百行。這個數字只會單向成長。

**目標**：一個 monorepo、一次登入、一個 sidebar 分成【客戶關係管理】【倉儲管理系統】【營運工具】三大項，部署在 Cloudflare 的 `platform.rueisiang.com`，權限用新的「角色＋資料範圍」RBAC 控管。

---

## 已定案的架構決策

| 項目 | 決定 |
|---|---|
| 推進方式 | 漸進式，模組逐一搬，舊系統維持運作到對應模組上線 |
| 語言 | 全 TypeScript |
| 前端 | **Vite + React Router（純 SPA）**，離開 Next.js |
| 後端 | **Hono on Cloudflare Workers** |
| RBAC | 角色 ＋ 資料範圍 |
| 規模 | 10–50 人內部使用 |
| 網域 | `platform.rueisiang.com` |
| 預算 | 以免費額度為主 |
| 第一個搬的模組 | **CRM** |

### 為什麼離開 Next.js 是對的

現有程式碼幾乎沒有用到 Next 的獨有能力。CRM 的頁面全是這個形狀：

```ts
const user = await requireCurrentUser("/tags");
return <TagManagement user={user} />;
```

一層很薄的 server component 做權限檢查，工作全丟給 client component。WMS 更極端——六個分頁全塞在一個 **1816 行**的 client component 裡，用 `pushState` 自己切換。

所以「離開 Next」實際上只是把那層薄殼換成 API 呼叫，內部邏輯原封不動。換來的是**整個 Next-on-Cloudflare 適配層風險歸零**，而且與出金表工具已經在跑的模式一致。

### 關鍵發現：D1 才是原生型態

CRM 的 `rueisiang-crm/db/schema.ts` 用的是 **`drizzle-orm/sqlite-core`**。跑在 Cloud Run 上時，是靠 `db/index.ts` 裡一個手寫的 `PostgresD1` class 模擬 D1 的 `.prepare().bind().first()` 介面（連 `?` → `$1,$2` 都是自己 replace）。WMS 是同一招，函式也叫 `getD1()`。

**搬上 D1，schema 層幾乎不用改；現在跑 Postgres 的那條路才是繞道。**

同時解決預算：Cloud Run 有免費額度但 **Cloud SQL 沒有**（最小規格約 US$8–10/月），關掉它等於整套基礎建設回到免費區間。

---

## Tech Stack

| 層 | 選擇 | 理由 |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | 免費、標準，單人維護也划算 |
| 前端 | Vite 8 + React 19 + React Router v7（SPA 模式） | 無適配層 |
| 前端資料層 | **TanStack Query** | 取代目前手刻的 fetch 與 `setInterval` 輪詢 |
| API | **Hono** on Workers | 輕量、Workers 原生、與 `@hono/zod-validator` 整合 |
| 型別共享 | **Hono RPC**（`hc<AppType>`） | 前後端端到端型別安全，不必手寫兩份介面 |
| 驗證 | **Zod** | 兩套現在都是手刻驗證，少數值得新增的相依 |
| 樣式 | Tailwind 4 + 抽出現有 CSS design system | CRM `app/globals.css` 那 553 行紅色品牌設計系統是實際在用的 |
| ORM | drizzle-orm 0.45.2，**單一 SQLite 方言 schema** | 沿用現況，砍掉平行維護的 Postgres schema |
| 資料庫 | **Cloudflare D1** | schema 本來就是 SQLite（實際免費額度以 Cloudflare 當前公告為準） |
| 檔案 | **R2**（取代 GCS） | WMS 倉位照片 |
| 快取 | Upstash Redis（沿用）或 Cloudflare KV | Upstash 是 REST-based，本來就能從 Workers 呼叫 |
| 測試 | Vitest + Playwright | 取代現行「對原始碼做 regex 斷言」的測試 |

---

## 專案結構

新資料夾：`C:\Users\llin8\Documents\Rueisiang\rueisiang-platform`（新 repo `ecotech-tw/rueisiang-platform`）

```
rueisiang-platform/
├─ apps/
│  ├─ portal/                  # Vite + React Router SPA
│  │  └─ src/
│  │     ├─ routes/
│  │     │  ├─ crm/            # 【客戶關係管理】
│  │     │  ├─ wms/            # 【倉儲管理系統】
│  │     │  └─ tools/          # 【營運工具】
│  │     └─ shell/             # AppShell + Sidebar
│  └─ api/                     # Hono on Workers（同時服務 portal 的靜態檔）
│     ├─ src/
│     │  ├─ routes/            # crm/ wms/ tools/ auth/ admin/
│     │  └─ middleware/auth.ts # RBAC 唯一強制點
│     └─ wrangler.toml
├─ packages/
│  ├─ auth/                    # OAuth + session + RBAC 核心（統一四份分歧的拷貝）
│  ├─ db/                      # drizzle schema + scope-aware query helpers
│  ├─ ui/                      # design system、AppShell、Sidebar
│  ├─ cyberbiz/                # CYBERBIZ API client（統一三份拷貝）
│  └─ config/                  # 共用 tsconfig / eslint / tailwind
└─ turbo.json, pnpm-workspace.yaml
```

**部署成一個 Worker**：`apps/api` 的 `wrangler.toml` 用 `[assets] directory = "../portal/dist"` 加上 `run_worker_first = ["/api/*"]`，靜態檔與 API 同一個 Worker、同一個網域。這正是出金表工具 `worker/wrangler.toml` 現在的設定，已驗證可行——直接沿用，不必重新摸索。

---

## RBAC 設計（角色 ＋ 資料範圍）

現況是兩套各自硬編碼的 `admin | viewer`。新模型：

```
users             取代兩份 app_users（id, email, google_subject, name, status）
roles             admin / manager / staff / viewer，可再增
permissions       字串常數，定義在程式碼（如 crm:customer:write、wms:inventory:count）
role_permissions  role ↔ permission
user_roles        user ↔ role，**附帶 scope**（scope_type, scope_id，null = 全域）
```

`permissions` 刻意定義在**程式碼而非資料庫**——權限鍵值是程式邏輯的一部分，放 DB 只會讓「哪些權限存在」與「程式檢查哪些權限」兩邊漂移。

### 改用 SPA 之後，權限模型反而更清楚

**所有安全性都在 API，前端的權限判斷純粹是外觀。** 這件事必須寫進規範並在 review 時嚴格執行——SPA 的 JS 全在使用者手上，前端藏起來的按鈕不是安全機制。

三個強制點：

1. **`apps/api/src/middleware/auth.ts`** — 每條路由宣告所需權限，中介層驗證。取代 WMS `proxy.ts` 的角色。
2. **`packages/db` 的 scope-aware helper** — 只導出**已套用 scope 過濾**的查詢函式，不導出裸的 db handle，讓「忘記過濾」在型別層就不可能發生。這是資料範圍的關鍵，也是最難的一層。
3. **前端 sidebar / 按鈕顯示** — 只影響體驗，不負責安全。

**必須保留的現有設計**：
- 角色**每次請求都回 DB 重讀**，不信 cookie 裡的 claim（CRM `lib/request-auth.ts` 已這樣做）——停權即時生效。
- 「不准停用最後一位管理者」的保護（CRM `app/api/admin/users/[id]/route.ts`）。
- 邀請制，不自動建帳號。

**必須砍掉**：CRM `app/chatgpt-auth.ts` / `lib/request-auth.ts` 裡對 `oai-authenticated-user-email` header 的直接信任。這在 OpenAI Sites 平台後面安全，但**搬到任何其他 proxy 後面就是身分偽造漏洞**。

**登入流程沿用但改造**：Google OAuth + PKCE 移到 Hono route（`/api/auth/google/start` → `callback`）。Session 仍是 Web Crypto HMAC 簽章的 HttpOnly cookie——現有實作**本來就刻意只用 `crypto.subtle`**，在 Workers 上不必改。ID token 驗簽採 WMS 對 Google JWKS 手動驗證的較嚴作法，而非 CRM 呼叫 userinfo 端點的版本。

---

## 遷移順序

每個 Phase 結束都是檢查點，確認後才進下一個。

**Phase 0 — 骨架與 spike（合併進行）**
- monorepo 初始化：pnpm workspaces、Turborepo、`packages/config`
- 最小的 Hono Worker + Vite SPA + D1 綁定，確認靜態檔與 `/api/*` 能在同一個 Worker 上共存
- 確認現有 `drizzle/` migration 能直接套用到 D1
- 風險已大幅降低，但仍要先跑通再往下寫

**Phase 1 — 登入與 RBAC**
- `packages/auth`：統一 OAuth ＋ 新 RBAC schema 與 `can()` 判定
- `packages/ui`：AppShell ＋ 三段式 sidebar
- portal 能登入、看到三個空的大項、`/admin/users` 能管人與權限
- 部署到 `platform.rueisiang.com`
- **此時尚未搬任何業務功能**——先讓殼站穩

**Phase 2 — CRM 搬入**
- 表：`customers`、`saved_views`、`customer_events`、`cyberbiz_webhook_events`、`customer_tag_catalog`
- sidebar【客戶關係管理】：客戶列表 / 新增客人 / 標籤管理 / 操作紀錄 / CYBERBIZ 同步
- `packages/cyberbiz` 首次成形（合併三份 client）
- 把 CRM 那個「client 端每 15 秒 `setInterval` poll webhook drain」改成 TanStack Query 或 Cron Trigger

**Phase 3 — 營運工具搬入**
- 出金表工具的 React+Vite UI 併進 portal；「Worker → GitHub Actions」執行模式不變，只換入口
- `cyberbiz-webhook-relay` 收編為 Hono route

**Phase 4 — WMS 搬入**（最後，最重）
- 表：`zones`、`warehouse_settings`、`layout_elements`、`product_categories`、`inventory_items`、`cyberbiz_product_links`、`zone_images`
- **主要工作量：拆掉 `warehouse-inventory/app/warehouse-app.tsx` 這 1816 行的單一元件**
- GCS → R2
- 命名衝突：`product_categories`、`audit_logs`、`inventory_items` 都是通用名，需前綴或併入統一設計

**Phase 5 — 舊系統下線**
- 兩個 Cloud Run 服務停掉、Cloud SQL instance 關掉（月費歸零）

---

## 去蕪存菁清單

**安全性**
- `oai-authenticated-user-*` header 信任

**框架層**
- Next.js 本身、vinext 0.0.50、`worker/index.ts`（vinext 入口）、CRM `npm run build`（vinext）與 CI 部署（`npx next build`）走不同路徑的陷阱

**四份拷貝合一**
- `auth-session.ts` / `google-oauth.ts` / `runtime-env.ts` / `cyberbiz-webhook.ts` → `packages/auth`、`packages/cyberbiz`
- 三份 CYBERBIZ client → `packages/cyberbiz`
- 兩份 `app_users` → 統一 `users`

**模板殘留（兩個 repo 都有）**
- `.openai/hosting.json`、`build/sites-vite-plugin.ts`、`db/index.sites.ts`、空的 `app/_sites-preview/`、`examples/d1/`、`app/chatgpt-auth.ts`

**雙軌維護**
- 平行的 SQLite ＋ Postgres 兩套 schema 與兩套 migration（WMS 已是 10 vs 4 個，不同步）→ 只留 SQLite/D1
- `PostgresD1` 墊片、`runtime-env.ts` 的雙模式 env 讀取（Workers 單一環境後不再需要）

**測試**
- 「對原始碼做 regex 斷言」的測試（`assert.match(app, /toggleMapFullscreen/)` 這種）→ Vitest 元件測試 + Playwright e2e
- 沒有被任何地方執行的 `tests/crm-audit.test.mjs`（但先讀過——它是一份可讀性很好的行為規格）

**文件**
- `warehouse-inventory/docs/GCP_DEPLOYMENT.md` 還在寫 HTTP Basic Auth，程式早就換成 Google OAuth

---

## 待決事項（Phase 0/1 檢查點處理）

1. **資料遷移範圍** — 使用者暫緩決定。兩套資料量都不大、系統都只有一個月大，傾向全量搬。
2. **email + 密碼登入是否保留** — CRM 有（PBKDF2 + 邀請連結），WMS 沒有。建議保留，因為不是每位同仁都有 Google 帳號。
3. **`inventory_items` 與 CRM 商品概念的主從關係** — WMS 的是 CYBERBIZ 目錄的本地鏡像，不是商品主檔；合庫前要先確定誰是 source of truth。
4. **Upstash Redis 是否換成 Cloudflare KV** — Phase 4 看實際延遲再決定。
5. **SPA 無 SSR 的取捨** — 內部系統不需要 SEO；首屏會有短暫載入。若某頁面在門市平板上明顯偏慢，再單獨處理。

---

## 驗證方式

**Phase 0**：Worker 能同時服務 SPA 靜態檔與 `/api/*`；能對 D1 讀寫；現有 migration 套用成功。
注意：開發機是 **Windows on ARM，`workerd` 沒有該平台執行檔**，所以 `wrangler dev` / `--dry-run` 必須在 CI 或 WSL 跑——這個限制在出金表工具已經遇過並記錄在案，不要重新踩。

**Phase 1**：Playwright 跑完整登入流程（Google OAuth → 未受邀帳號被擋 → 受邀帳號成功 → sidebar 依權限顯示不同項目 → 登出）。RBAC 用 Vitest 涵蓋：無權限回 403、scope 過濾確實限制查詢結果、最後一位管理者不能被停用。
**額外必測**：直接對 API 發請求（繞過前端）確認權限確實由 API 擋下——這是 SPA 架構最關鍵的一條驗證。

**每個模組搬入後**：對照舊系統跑同一組操作逐項比對。CRM 用客戶列表的篩選/排序/分頁；WMS 用倉位地圖與庫存盤點。

**部署**：GitHub Actions 跑型別檢查、lint、Vitest、Playwright、build，通過才部署到 Cloudflare。
