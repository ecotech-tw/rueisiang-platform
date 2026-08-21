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

**目標**：一個 monorepo、一次登入、一個 sidebar 分成【客戶關係管理】【倉儲管理系統】【營運工具】三大項，部署在 Cloudflare 的 `platform.rueisiang.com`，權限用新的角色式 RBAC 控管（原本規劃的「資料範圍」已移除，理由見下方 RBAC 一節）。

---

## 已定案的架構決策

| 項目 | 決定 |
|---|---|
| 推進方式 | 漸進式，模組逐一搬，舊系統維持運作到對應模組上線 |
| 語言 | 全 TypeScript |
| 前端 | **Vite + React Router（純 SPA）**，離開 Next.js |
| 後端 | **Hono on Cloudflare Workers** |
| RBAC | 角色（原訂的「資料範圍」已移除——舊系統的資料沒有照店別或倉庫切） |
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

## RBAC 設計（角色）

現況是兩套各自硬編碼的 `admin | viewer`。新模型：

```
users             取代兩份 app_users（id, email, google_subject, name, status）
roles             admin / manager / staff / viewer，可再增
permissions       字串常數，定義在程式碼（如 crm:customer:write、wms:inventory:count）
role_permissions  role ↔ permission
user_roles        user ↔ role
```

> **修正（2026-08-18）：拿掉「資料範圍」。**
>
> 這份計畫原本寫的是「角色＋資料範圍」，角色可以綁在某個店別或倉庫上。實作完之後
> 回頭對照兩套舊系統的 schema，發現那個前提不成立：
>
> - CRM 的 `customers` **沒有店別欄位**，客戶是全公司共用的（`source_channel` 是
>   「手動還是 CYBERBIZ 來的」，與門市無關）
> - WMS 的 `zones` **沒有倉庫欄位**，`warehouse_settings` 只有一列——就是一個倉庫、
>   一張地圖。唯一叫 `warehouse_scope` 的欄位在 `cyberbiz_product_links`，值永遠是
>   `'company'`，那是 CYBERBIZ 自己「公司層級 vs POS 門市層級庫存」的概念
>
> 沒有東西可以照範圍過濾，留著只會讓權限管理頁問一個沒有正確答案的問題，
> 而且看起來像一道實際上不存在的防線——選了「店別」的人跟選「全部資料」的人
> 看到的東西一模一樣。
>
> `user_roles` 的 `scope_type` / `scope_id` 欄位保留（預設空字串＝全域），
> 哪天真的有模組需要時不必再開 migration。**但順序是：先給該資料表加上店別欄位、
> 把過濾接進那條查詢，最後才在 UI 開放那一種範圍。** 不要再從 UI 開始做。

`permissions` 刻意定義在**程式碼而非資料庫**——權限鍵值是程式邏輯的一部分，放 DB 只會讓「哪些權限存在」與「程式檢查哪些權限」兩邊漂移。

### 改用 SPA 之後，權限模型反而更清楚

**所有安全性都在 API，前端的權限判斷純粹是外觀。** 這件事必須寫進規範並在 review 時嚴格執行——SPA 的 JS 全在使用者手上，前端藏起來的按鈕不是安全機制。

三個強制點：

1. **`apps/api/src/middleware/auth.ts`** — 每條路由宣告所需權限，中介層驗證。取代 WMS `proxy.ts` 的角色。
2. **`packages/db` 的查詢 helper** — 只導出具名的查詢函式，不導出裸的 db handle。（原本這一條是「scope-aware helper」，資料範圍拿掉之後剩下這個原則。）
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

**目前進度：Phase 0–4 完成，跑在 <https://platform.rueisiang.com>。** 只剩 Phase 5
（舊系統下線），而那件事刻意不急。

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

**Phase 4 — WMS 搬入**（最後，最重）✅
- 表：搬了 8 張（原本 12 張）。`app_users` 被平台的 `users` 取代、`audit_logs`
  併進共用的 `activity_events`、`line_bot_destinations` 與 `inventory_alert_states`
  只服務 LINE bot 所以不搬
- 命名衝突的處理：只有 `cyberbiz_webhook_events` 真的撞到（平台已有
  `cyberbiz_customer_webhooks`），改名 `cyberbiz_product_webhooks` 讓兩者對稱。
  `product_categories`、`inventory_items` 沒有實際衝突，維持原名
- GCS → R2，另附一個檔案系統版的 R2 給本機開發用（這台機器沒有 workerd）

**實際做出來跟計畫不一樣的地方**（記下來是因為理由比結論有用）：

- **`warehouse-app.tsx` 不是被「拆」，是被重寫。** 1816 行裡互動地圖與 PNG 匯出
  的邏輯糾纏在一起，照著拆只會把同樣的糾纏原封搬過來。重寫之後互動用 DOM
  （文字換行、hover、鍵盤焦點、螢幕閱讀器都是免費的）、匯出用 canvas，兩件事
  各自獨立。舊系統那份 canvas 本來就只是為了匯出而存在
- **Redis 快取不是「拿掉」，是原封不動搬過來。** 見下面待決事項 4
- **地圖改成滿版**：控制項浮在地圖上，不是「標題列 ＋ 面板 ＋ 面板裡的地圖」。
  地圖是那一頁唯一的內容，其他東西都是為了操作它而存在的

**舊資料怎麼搬過來**（Phase 4 的收尾）：

不碰 Cloud SQL 的憑證。舊系統的 `GET /api/dashboard` 一次回傳倉位、標示、分類、
商品與 CYBERBIZ 連結，剛好就是要搬的東西——在瀏覽器裡登入舊站、打開那個網址、
存成檔案就好。三步：

1. `node packages/db/scripts/import-wms.mjs dashboard.json > packages/db/imports/wms-YYYY-MM-DD.sql`
2. SQL 進 PR，逐行看清楚會寫什麼。資料搬遷不可逆，看不到內容就按下去不是好主意
3. 合併後跑 `匯入舊 WMS 的資料` 這支 workflow（手動觸發，要自己打檔名）

全部是 `INSERT OR IGNORE`——**只補不改**，重跑安全，已經在平台上編輯過的資料
不會被舊資料蓋掉。

**兩件事沒搬**：現場照片（檔案在 GCS、平台用 R2，只搬索引會變成一堆破圖；
2026-08-21 那份匯出的 `images` 是空的，所以目前沒有東西要搬），以及操作歷史
（`/api/dashboard` 只回傳最新一筆，而且舊站還會留著）。

**踩過的坑：SQL 常值裡的換行。** 倉位 B003 的備註是多行的，`quote()` 原本直接
把換行寫進常值——SQLite 允許，但套用端逐行讀，那句 `INSERT` 會被看成兩句壞掉的
SQL。改成接 `|| char(10) ||`，存進去的值一模一樣。假資料裡只有單引號沒有換行，
所以測試沒抓到——**又一次「測試照抄了自己的假設」**。

**CYBERBIZ 這個 API 的三個坑**（都是打到正式站才知道的，寫在這裡是因為看文件看不出來）：

- `per_page` 最多 **50**。給 100 會直接回 500，不是悄悄截短
- `/v1/products/search?q=` 搜的是**商品名稱，不是 SKU**。拿 SKU 去搜一定找不到
- **`/v1/products/{id}` 的回應裡沒有 `id`。** 列表端點有，單一商品端點沒有。
  攤平的函式看到沒有 id 的商品會整個丟掉，於是「盤點推上官網」與「官網同步回
  WMS」兩條路一起死，而錯誤訊息指向完全無辜的 SKU。修法是把問的時候就知道的
  那個 id 補回去

**商品庫存的 webhook**（Phase 4 的最後一塊）：舊系統有 `variants/update` 這條路，
搬進來的時候漏掉了——表（`cyberbiz_product_webhooks`）建了，路由沒寫。症狀是
官網改了數量平台不動，而且沒有任何跡象說那個數字舊了。網址與訂閱方式見
deployment-setup 的第 6 節。

跟舊系統不同的一點：**topic 標頭不當成判斷依據**。舊系統的 `cyberbizWebhookTopic`
在沒有標頭時預設回 `variants/update`，等於根本沒在檢查。改成看 payload 自己的
欄位（`classifyPayload`），那是實際擋得住東西的那一層。

**Phase 5 — 舊系統下線**
- 兩個 Cloud Run 服務停掉、Cloud SQL instance 關掉（月費歸零）
- **先別急著關**：平台這邊要實際用一段時間，確認沒有漏掉的功能。舊系統還在
  跑的成本，遠低於「關掉之後才發現少了什麼」

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

## 待決事項（Phase 0/1 提出，已陸續回答）

1. **資料遷移範圍** — 使用者暫緩決定。兩套資料量都不大、系統都只有一個月大，傾向全量搬。
2. **email + 密碼登入是否保留** ✅ **保留**。不是每位同仁都有 Google 帳號。
   PBKDF2 的迭代次數要注意：Workers 上限 100,000，照抄 CRM 的 120,000 會在正式站
   丟 `NotSupportedError`，而測試（跑在 Node 上）跟 CI 都不會發現
3. **`inventory_items` 與 CRM 商品概念的主從關係** ✅ **CYBERBIZ 是庫存數量的
   source of truth**，`inventory_items` 是本地鏡像，不是商品主檔。兩個方向都有：
   - 官網 → WMS：手動同步與 webhook，覆寫本地數量
   - WMS → 官網：**盤點**。人在現場數完之後推上去
   兩邊的寫入順序刻意相反。客戶那邊是「先寫官網、成功了才寫本地」；庫存這邊是
   「先寫本地」——人已經數完了，不能因為官網連不上就叫他重數，更不能把結果丟掉。
   推不上去時盤點仍然成立，只把連結標成失敗，等下次同步補
4. **Upstash Redis 是否換成 Cloudflare KV** ✅ **維持 Upstash，用同一個實例。**
   一度以為要換，理由是「Workers 開不了 Redis 連線」——那句話只對了一半：
   Workers 確實開不了原生 TCP，但舊 WMS 的 `redis-cache.ts` 走的是 Upstash 的
   **REST API**，純 fetch over HTTPS，Worker 原封不動就打得到。不必換、不必新增
   任何服務。快取層另外做到「壞掉就退回直接問官網」，所以它是加速用的，
   不是功能的一部分
5. **SPA 無 SSR 的取捨** — 內部系統不需要 SEO；首屏會有短暫載入。若某頁面在門市平板上明顯偏慢，再單獨處理。

---

## 驗證方式

**Phase 0**：Worker 能同時服務 SPA 靜態檔與 `/api/*`；能對 D1 讀寫；現有 migration 套用成功。
注意：開發機是 **Windows on ARM，`workerd` 沒有該平台執行檔**，所以 `wrangler dev` / `--dry-run` 必須在 CI 或 WSL 跑——這個限制在出金表工具已經遇過並記錄在案，不要重新踩。

**Phase 1**：Playwright 跑完整登入流程（Google OAuth → 未受邀帳號被擋 → 受邀帳號成功 → sidebar 依權限顯示不同項目 → 登出）。RBAC 用 Vitest 涵蓋：無權限回 403、scope 過濾確實限制查詢結果、最後一位管理者不能被停用。
**額外必測**：直接對 API 發請求（繞過前端）確認權限確實由 API 擋下——這是 SPA 架構最關鍵的一條驗證。

**每個模組搬入後**：對照舊系統跑同一組操作逐項比對。CRM 用客戶列表的篩選/排序/分頁；WMS 用倉位地圖與庫存盤點。

**Phase 2–4 學到的一件事，寫在這裡免得下次重犯**：好幾個 bug 是「測試全過、CI
全綠，但正式站壞掉」——PBKDF2 的迭代次數（Node 允許、Workers 不允許）、
CYBERBIZ 的 `per_page`（超過 50 直接回 500，不是截短）、送給官網的欄位包錯層
（測試斷言的正是那個錯的格式）。共同點是**測試把我們自己的假設抄了一份**，
所以只驗證了「程式照著假設跑」。

真正抓到這些的是**拿真的東西跑一次**：真的瀏覽器、真的滑鼠事件、真的檔案、
真的 API。搬完一個模組之後，那一步不能省。

**部署**：GitHub Actions 跑型別檢查、lint、Vitest、Playwright、build，通過才部署到 Cloudflare。
