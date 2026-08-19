# 瑞香內部系統整合平台

把 CRM、WMS 與營運工具整合成一個入口：一次登入、一個 sidebar、一套權限，部署在 Cloudflare。

目前狀態：**Phase 1 的程式碼完成**——Google 登入、角色式 RBAC、權限管理頁都能用了。
還沒部署：D1 與 Google OAuth client 尚未開通，步驟見 `docs/deployment-setup.md`。
三大項底下的業務功能仍是佔位頁，從 Phase 2 起逐一搬入。

## 為什麼要做這件事

原本四套系統（CRM、WMS、CYBERBIZ webhook relay、出金表工具）是同一個模板的四份拷貝，會各自演化。同名的共用檔案已經分歧：`auth-session.ts` 差 263 行、`cyberbiz-webhook.ts` 差 238 行、`google-oauth.ts` 差 169 行。CRM 與 WMS 各有一份獨立的 `app_users`，各自實作了一次 `admin|viewer`；CYBERBIZ API client 有三份。

同一個 bug 要修三次，這個數字只會單向成長。

## 架構

```
apps/
  portal/     Vite + React Router SPA（純前端）
  api/        Hono on Cloudflare Workers（同時服務 portal 的靜態檔）
packages/
  auth/       權限目錄、OAuth、session、RBAC
  db/         drizzle schema（D1）＋ migrations
  cyberbiz/   CYBERBIZ API client（合併原本的三份）
  config/     共用 tsconfig
tools/        跑在 GitHub Actions runner 上的東西，刻意不在 pnpm workspace 裡
  cyberbiz-monthly-payout/   出金表 driver（純 JS ＋ npm lockfile）
```

**部署成一個 Worker**：`apps/api/wrangler.toml` 的 `[assets]` 指向 `../portal/dist`，`run_worker_first = ["/api/*"]` 讓 API 進 Worker、其餘走 Static Assets，同一個網域。

**安全性全部在 API。** 前端的權限判斷（sidebar 顯示哪些項目、按鈕要不要出現）純粹是外觀——SPA 的 JavaScript 全在使用者手上，藏起來的按鈕不是安全機制。每一條 API 路由都必須自己驗權限。

## 開發

```bash
pnpm install
pnpm dev          # portal 在 5173，API 在 8787
pnpm build
pnpm typecheck
pnpm test
```

`pnpm dev` 會同時起兩個東西：Vite（前端，有 HMR）與 `apps/api/src/dev/server.ts`
（把 Hono app 接上 node:http，配 node:sqlite 當 D1）。**這裡不用 `wrangler dev`**，
理由見下面那節——這台開發機起不了 workerd。

開 <http://localhost:5173/dev> 選一個身分直接進去，跳過 Google OAuth。種子帳號
涵蓋管理者、主管、一般同仁、檢視者、沒有角色、已停用六種，方便直接比對
不同權限看到的畫面。

資料存在 `apps/api/local.sqlite`（已 gitignore），重開會留著；想重來就把檔案刪掉。

需要金鑰的功能（例如 CYBERBIZ 同步）從 `apps/api/.dev.vars` 讀，格式跟 wrangler 一樣，
一行一個。這個檔也在 .gitignore 裡：

```
CYBERBIZ_API_TOKEN=你的token
```
`/dev` 那兩條路由是 dev server 自己接的，不在 Hono app 裡，所以正式環境不存在。

資料庫 schema 改動後：

```bash
cd packages/db && pnpm generate    # 產生 migration SQL
```

## 出金表：它跑在哪、憑證從哪來

出金表**不在 Worker 裡跑**。Worker 有執行時間上限，而這個流程要開瀏覽器登
CYBERBIZ、等 2FA 驗證信、下載 xlsx、寫欄位、上傳 Drive——一趟三分半。

所以分成兩邊：

| 誰 | 做什麼 | 碰得到憑證嗎 |
|---|---|---|
| 平台（Worker） | 記「有哪些店」「誰按了執行」，`workflow_dispatch` 觸發 | ❌ 只有一顆 GitHub PAT |
| GitHub Actions runner | 真正跑 `tools/cyberbiz-monthly-payout/driver.mjs` | ✅ 全部 |

`tools/` 刻意留在 pnpm workspace 之外（`pnpm-workspace.yaml` 只 glob `apps/*`
與 `packages/*`）：它相依 Playwright，拉進來會讓每個人的 `pnpm install` 都扛一份
只有 runner 用得到的瀏覽器函式庫。它自己用 `npm ci`，CI 另外跑 `node selftest.mjs`。

**店別清單有兩個來源。** `config.json` 是這個工具自己的設定（CYBERBIZ 網址、Drive
根目錄、欄位公式），由維護者管；`stores.json` 是平台「店別設定」頁存檔時寫回來的，
由同仁管。`loadConfig` 讀到 `stores.json` 就以它為準，沒有那個檔案時照 `config.json` 走。

### 需要哪些 secret

設在**本 repo** 的 Settings → Secrets and variables → Actions：

| Secret | 是什麼 |
|---|---|
| `CYBERBIZ_USERNAME` / `CYBERBIZ_PASSWORD` | CYBERBIZ 後台帳密 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 用戶端（桌面應用程式類型） |
| `GOOGLE_REFRESH_TOKEN` | Drive ＋ Sheets 讀寫 |
| `GMAIL_REFRESH_TOKEN` | Gmail 唯讀（收 2FA 驗證信與報表附件） |

另外 Worker 端需要 `PAYOUT_GITHUB_TOKEN`：fine-grained PAT，給本 repo 的
**Actions 讀寫**（觸發與查狀態）與 **Contents 讀寫**（設定頁寫回 `stores.json`）。

### 這些憑證掛在哪個 Google 帳號

**寫下來是因為它一點都不明顯，而且過期時第一個要回答的就是這題。**

- GCP 專案 `rueisiang-505215`，擁有者 `rueisiang.soap@gmail.com`——OAuth 用戶端
  （client id / secret）建在這裡，**要用這個帳號登入 Console 才看得到**
- `GOOGLE_REFRESH_TOKEN` 授權給 `rueisiang.soap@gmail.com`：Drive 的「通路銷售紀錄」
  在這個帳號底下
- `GMAIL_REFRESH_TOKEN` 授權給 `eli-lin@ecotech.tw`：2FA 驗證信與 CYBERBIZ 寄來的
  報表附件都進這個信箱

**兩個是不同帳號**，所以下面的指令要帶帳號當提示，免得瀏覽器拿已登入的那個去授權。

### 重新產生 refresh token

```bash
cd tools/cyberbiz-monthly-payout
npm ci
node setup.mjs auth  rueisiang.soap@gmail.com   # → GOOGLE_REFRESH_TOKEN
node setup.mjs mail  eli-lin@ecotech.tw         # → GMAIL_REFRESH_TOKEN
```

要跑兩次：scope 不同，Google 給的是兩個不同的 token。`setup.mjs` 會去
`Downloads` 找 `client_secret_*.json`（Console 下載的那份，**應用程式類型要選
「桌面應用程式」**，選 Web 會失敗），把四個值一起寫進 `.env`，你再貼進 GitHub Secrets。

`.env` 已被 gitignore。`mail` 跑完會印出實際授權到的信箱讓你對照。

**OAuth 同意畫面還在「測試中」**，所以：

- 兩個帳號都要在「測試使用者」名單裡
- 會看到「Google 尚未驗證這個應用程式」→ 進階 → 繼續前往
- 測試中的 token 官方說法是 7 天到期。若重產出來的 token 過幾天就失效，就是卡在
  這條，要把發布狀態改成「正式版」

## 這台開發機的兩個限制

**1. Windows on ARM 跑不了 `workerd`。** **任何** wrangler 指令在本機都會失敗，連 `wrangler whoami` 都是（`Unsupported platform: win32 arm64`）——wrangler 一啟動就載入 workerd。這不是設定問題，是這個平台沒有對應的執行檔。

所以本機開發改用 `apps/api/src/dev/server.ts`：Worker 的進入點本來就只是一個 fetch handler，接上 node:http 再配 node:sqlite 當 D1，就能跑真正的路由、真正的 SQL、真正的 migration。部署與 Worker 設定的實機驗證都在 CI（Linux）上做。

因此 `pnpm-workspace.yaml` 裡把 `workerd` 的安裝腳本關掉——開著會讓整個 `pnpm install` 直接失敗。CI 若需要那支執行檔，在部署 workflow 裡單獨處理。

**2. migration 的本機驗證用 `node:sqlite`。** D1 就是 SQLite，所以產生的 migration 可以直接用 Node 24 內建的 `node:sqlite` 套用驗證，不需要 workerd，也不必額外裝套件。

## 待辦（依 Phase）

| Phase | 內容 |
|---|---|
| 0 ✅ | monorepo 骨架、portal 外殼與 sidebar、Hono worker、D1 schema 與 migration |
| 1 ✅ | Google OAuth ＋ 帳密登入、邀請連結、RBAC、自訂角色與直接授予、權限管理頁、部署到 `platform.rueisiang.com` |
| 2 ✅ | CRM 搬入：客戶列表與編輯、標籤、儲存的視圖、操作紀錄、CYBERBIZ 同步與 webhook |
| 3 ✅ | 營運工具搬入：出金表執行頁與店別設定，driver 與 workflow 一起進 `tools/` |
| 4 | WMS 搬入（含拆掉 1816 行的 `warehouse-app.tsx`） |
| 5 | 舊系統下線、Cloud SQL 關掉 |

Phase 1 的權限比原訂計畫多做了兩層：**自訂角色**（管理者自己組合權限，不必改
程式碼）與**直接授予**（繞過角色，給單一個人的例外）。原本只有四個寫死的系統角色。

完整計畫與去蕪存菁清單見 `docs/migration-plan.md`。
