# 瑞香內部系統整合平台

把 CRM、WMS 與營運工具整合成一個入口：一次登入、一個 sidebar、一套權限，部署在 Cloudflare。

目前平台包含 CRM、倉儲、營運工具與小香助理，正式站在
<https://platform.rueisiang.com>。

## 架構

```
apps/
  portal/     Vite + React Router SPA（純前端）
  api/        Hono on Cloudflare Workers（同時服務 portal 的靜態檔）
packages/
  auth/       權限目錄、OAuth、session、RBAC
  db/         drizzle schema（D1）＋ migrations
  cyberbiz/   CYBERBIZ API client 與 webhook 驗證
  config/     共用 tsconfig
tools/        跑在 GitHub Actions runner 上的東西，刻意不在 pnpm workspace 裡
  cyberbiz-reports/          CYBERBIZ 出金表與商品銷售報表 driver（純 JS ＋ npm lockfile）
  shopee-sales-report-export/ 蝦皮銷售報表直接上傳、整理與 Drive 上傳服務（純 JS）
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

Codex 與 Claude 同時開發時，請使用各自的 worktree 與 port：Codex 是 Portal `5174`、
API `8788`；Claude 是 Portal `5175`、API `8789`。完整規則見
[`docs/development-workflow.md`](./docs/development-workflow.md)。

**文件寫在哪**：要照著做的步驟在 [`.claude/skills/`](./.claude/skills/)（開通與部署看
`platform-deploy`，出金表與商品銷售報表看 `cyberbiz-reports`）；系統現況與設計在
[`docs/`](./docs/)；還沒做的事在下面的「下一步」。分類規則見
[`docs/development-workflow.md`](./docs/development-workflow.md)。

開 <http://localhost:5173/dev> 選一個身分直接進去，跳過 Google OAuth。種子帳號
涵蓋管理者、主管、一般同仁、檢視者、沒有角色、已停用六種，方便直接比對
不同權限看到的畫面。

資料存在 `apps/api/local.sqlite`（已 gitignore），重開會留著；想重來就把檔案刪掉。

需要金鑰的功能（例如 CYBERBIZ 同步）從 `apps/api/.dev.vars` 讀，格式跟 wrangler 一樣，
一行一個。這個檔也在 .gitignore 裡：

```
CYBERBIZ_API_TOKEN=你的token
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=你的token
```

Upstash 只影響 CYBERBIZ 商品目錄查詢的速度：沒設定的話用 SKU 連結品項或定時鏡像時
會直接翻官網商品目錄，功能是好的，只是要等幾秒。
`/dev` 那兩條路由是 dev server 自己接的，不在 Hono app 裡，所以正式環境不存在。

資料庫 schema 改動後：

```bash
cd packages/db && pnpm generate    # 產生 migration SQL
```

## 下一步

**這一節是這個 repo 唯一的 TODO 清單。** 做掉一項就從這裡刪掉；過程中發現新的就加進來。
不要在別的文件裡另外開一份待辦（規則見
[`docs/development-workflow.md`](./docs/development-workflow.md)）。

每一項的完成條件都一樣：程式碼、測試、文件與部署／回滾說明四樣齊備。**沒有實機
smoke test 的功能只能標記為「可合併」，不能標記為「已上線」。**

### HR：排班、出勤與薪資

領域模型、候選資料表、SQL 約束、權限與驗收契約見
[`docs/hr-system-design.md`](./docs/hr-system-design.md)。先確認制度與資料庫設計，
再按依賴切片實作；不以設計提案代替法遵確認。

- [ ] 確認雇主法人、聘僱與工時制度、日薪係數、業績來源、分配方式、發薪區間及審核權限，完成設計 review。
- [ ] 建立主管的 scope／雇主資料範圍授權；員工櫃點指派不等於管理權限。
- [ ] 補上雇主編輯／停用與已結束任職、指派的審核修訂流程，不直接覆寫歷史。
- [ ] 實作班次版本、快速排班及發布，再接網站打卡、補卡、出勤計算與審核。
- [ ] 實作假別額度、請假／加班、補休與颱風等特殊給薪日。
- [ ] 實作業績快照、獎金政策／池、權重分配與審核。
- [ ] 實作薪資／投保版本、月薪試算、覆核、結帳、調整單及私密薪資單。
- [ ] 完成實機 smoke 與至少兩個完整月份平行計薪對帳，再正式啟用薪資結算。
- [ ] 接入具備可信員工身分的 RFID／LINE／MCP 與圖片排班草稿，不繞過既有審核。

### 蝦皮：改用 Open API 取數

銷售報表目前是半自動——人要登入賣家中心匯出 xlsx 再上傳。卡在登入的簡訊 OTP。
Open Platform 是另一條路：一次性授權換 refresh token，之後程式續期。POC 的範圍、
資料對照與驗收條件見 [`docs/shopee-open-api-poc.md`](./docs/shopee-open-api-poc.md)。

- [ ] 申請 Shopee Open Platform 開發者帳號，取得 `partner_id` 與 `partner_key`（人類執行）。
- [ ] 決定 T 欄「其他服務費」要不要計入業績——這題會改動驗收基準，沒答案不要開工。
- [ ] 實作「API JSON → orders 列」轉換與 token 續期，用 2026-07 跟既有結果對數字。

### 蝦皮：訂單自動扣 WMS 庫存

同一批貨兩個通路在賣，但只有官網會自動扣帳，倉庫補扣時會扣到重複的部分。根因是蝦皮的
銷售沒進系統，不是兩邊庫存數字對不上。設計見
[`docs/shopee-inventory-sync-design.md`](./docs/shopee-inventory-sync-design.md)，
它依賴上面那項的授權與 token 續期先做完。

- [x] 把蝦皮的外部 SKU 統一成「商品ID_規格ID」；既有只有商品 ID 的 mapping 仍會在找不到
      精確規格 mapping 時 fallback，避免既有報表因格式更新而無法匯入。
- [x] 新增組合包用料表：一筆通路商品 mapping 可對應多個 WMS 用料，含 WMS 的編輯 UI，
      報表匯入時會依用料數量展開。
- [ ] 決定在哪個訂單狀態扣帳，以及上線前的既有訂單要不要回補。
- [ ] 訂閱 push code 3、驗簽、對應到 `product_sku_mappings` 後扣帳，含冪等與退貨加回。

### 小香：MCP tools

`mcp` 目前只是 tool registry 上的 surface 標記，除了唯讀的
`POST /api/mcp/cyberbiz-reports` 之外，還沒有通用的 MCP transport adapter。

- [ ] 先決定範圍：把平台內建 tools 暴露成 MCP server，或另外支援外部 MCP server；
      兩者的 authentication、權限與風險不同。
- [ ] 以現有 `ToolContract`、permission 與 surface registry 為基礎，建立 MCP transport、
      tool listing、tool call、timeout、錯誤格式與 audit log。
- [ ] 為 MCP client／server 設定 allowlist、credential 隔離、request size／rate limit 與
      取消機制，不能繞過目前 Sandbox／LINE 的 tool permission。
- [ ] 補上 protocol、權限、錯誤、重試與並行請求 tests，並提供本機與 Cloudflare
      deployment 的設定說明。

接外部 MCP 工具的限制與風險見
[`docs/assistant-multi-account-design.md`](./docs/assistant-multi-account-design.md)。

### 小香：Relay 與用量

- [ ] 評估 [Workers VPC `cf1:network`](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)
      經 Cloudflare Gateway 的 public egress，確認是否能避開 Workers direct egress restriction
      與 `CF-Worker` header；目前 smoke test 因 CI token 沒有 Connectivity Directory 權限而
      回傳 code `10196`，尚未驗證 ChatGPT HTTP／SSE。**完成權限、VPC／Gateway policy 與
      真實 Codex SSE 驗收前，不得移除 NAS relay。**
- [ ] 新增 LINE Push API 用量分析，至少顯示 fixed-window 用量、剩餘額度、查詢時間區間
      與群組／事件明細。
- [ ] 建立日／週／月與自訂 duration 的群組、模型、tool 用量分析頁。

### 小香：多帳號與客服

官網客服自己的 LINE 官方帳號、channel／對話兩層工具權限的後續、每個對話的 system prompt
補充，以及客服的身分驗證。設計已經寫好但一行都還沒做，見
[`docs/assistant-multi-account-design.md`](./docs/assistant-multi-account-design.md)。

### 倉儲：R2 bucket

R2 是倉位照片在沒有 NAS 時的 fallback，目前**還沒開通**（要在 Cloudflare 走一次訂閱流程）。
兩種儲存都沒設定時，上傳照片會回「尚未設定照片儲存空間」，地圖與庫存不受影響。
開通步驟見 `platform-deploy` skill 的 5.1。

### Production smoke 與 CYBERBIZ webhook

下列驗收需要正式帳號或 CYBERBIZ 後台權限，不能用本機 fixture 取代；完成後把結果留在
對應 PR／deploy 紀錄，不要把登入 cookie 或外部 payload 貼進 repo。

- [ ] WMS：登入正式站完成單一 CYBERBIZ 品項同步與全部同步，確認數量、安全庫存與操作紀錄。
- [ ] CRM：登入正式站完成客戶列表、標籤與核准的測試客戶寫入 smoke test，確認 target tables 與 CYBERBIZ 回應一致。
- [ ] CYBERBIZ：在後台確認實際啟用的會員、商品／庫存 Webhook Events、endpoint 與驗證設定；再以 production event log 對照是否有漏送。

## 出金表：它跑在哪、憑證從哪來

出金表**不在 Worker 裡跑**。Worker 有執行時間上限，而這個流程要開瀏覽器登
CYBERBIZ、等 2FA 驗證信、下載 xlsx、寫欄位、上傳 Drive——一趟三分半。

所以分成兩邊：

| 誰 | 做什麼 | 碰得到憑證嗎 |
|---|---|---|
| 平台（Worker） | 記「有哪些店」「誰按了執行」，`workflow_dispatch` 觸發 | ❌ 只有一顆 GitHub PAT |
| GitHub Actions runner | 真正跑 `tools/cyberbiz-reports/payout/driver.mjs` 或 `sales/driver.mjs` | ✅ 全部 |

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

另外 Worker 端需要共用的 `GITHUB_TOKEN`：fine-grained PAT，需給出金與蝦皮所使用 repo 的
**Actions 讀寫**（觸發與查狀態）；若出金設定頁要寫回 `stores.json`，還需要 **Contents 讀寫**。

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
cd tools/cyberbiz-reports
npm ci
node setup.mjs auth  rueisiang.soap@gmail.com   # → GOOGLE_REFRESH_TOKEN
node setup.mjs mail  eli-lin@ecotech.tw         # → GMAIL_REFRESH_TOKEN
```

要跑兩次：scope 不同，Google 給的是兩個不同的 token。`setup.mjs` 會去
`Downloads` 找 `client_secret_*.json`（Console 下載的那份，**應用程式類型要選
「桌面應用程式」**，選 Web 會失敗），把四個值一起寫進 `.env`，你再貼進 GitHub Secrets。

`.env` 已被 gitignore。`mail` 跑完會印出實際授權到的信箱讓你對照。

## 蝦皮銷售報表

蝦皮報表工具位在營運工具底下的「蝦皮銷售報表」。使用者直接上傳從蝦皮下載的加密
xlsx，平台會暫存後交給 GitHub Actions 解密、整理並上傳到設定好的 Google Drive；目前不會自動登入蝦皮，
需要共用的 `GITHUB_TOKEN`，只用來觸發 GitHub Actions workflow。
報表工具也可以獨立使用：`node tools/shopee-sales-report-export/driver.mjs --input
<檔案> --password <密碼> --drive-folder-url <Drive資料夾連結>`。

工具輸出的 `業績計算` 以 A 欄訂單編號去重，單筆為 `G-S-U`；`商品銷售統計` 以
`Z＋AA` 合併商品鍵，加總 AH 數量。加密 xlsx 在 Windows 會使用 Microsoft Excel
解密，Linux/GCP 需要安裝 `msoffcrypto-tool`。未來若能以 Email OTP 搭配 Gmail API
穩定完成蝦皮驗證，再另行增加自動匯出流程；目前不會把驗證碼寫入平台或嘗試繞過。

**OAuth 同意畫面還在「測試中」**，所以：

- 兩個帳號都要在「測試使用者」名單裡
- 會看到「Google 尚未驗證這個應用程式」→ 進階 → 繼續前往
- 測試中的 token 官方說法是 7 天到期。若重產出來的 token 過幾天就失效，就是卡在
  這條，要把發布狀態改成「正式版」

## 倉儲需要的兩個外部服務

兩個都是「沒有也能跑，只是少一塊」，不會讓整個系統起不來——這是刻意的，
而且有測試釘著。

| 服務 | 給誰用 | 沒設定會怎樣 | 正式站 |
|---|---|---|---|
| **R2** bucket `rueisiang-platform-uploads` | 倉位的現場照片 | 上傳回「尚未設定照片儲存空間」，地圖與庫存完全正常 | ❌ 還沒開 |
| **Upstash Redis**（`UPSTASH_REDIS_REST_URL` / `_TOKEN`） | 快取 CYBERBIZ 商品目錄一天 | SKU 連結品項或定時鏡像時直接翻官網，慢幾秒但功能正常 | ✅ |

Upstash Redis 是平台的選用快取服務。Workers 開不了原生的 Redis 連線，但 Upstash
的 REST 端點只是一個 HTTPS 請求——那正好是 Worker 做得到的形式。

R2 要先建 bucket：

```bash
npx wrangler r2 bucket create rueisiang-platform-uploads
```

（開通 R2 要在 Cloudflare 完成一次訂閱流程。用量在免費額度內是 $0：10 GB 儲存、
流量不計費，而倉位照片撐死幾百 MB。）

## 這台開發機的兩個限制

**1. Windows on ARM 跑不了 `workerd`。** **任何** wrangler 指令在本機都會失敗，連 `wrangler whoami` 都是（`Unsupported platform: win32 arm64`）——wrangler 一啟動就載入 workerd。這不是設定問題，是這個平台沒有對應的執行檔。

所以本機開發改用 `apps/api/src/dev/server.ts`：Worker 的進入點本來就只是一個 fetch handler，接上 node:http 再配 node:sqlite 當 D1，就能跑真正的路由、真正的 SQL、真正的 migration。部署與 Worker 設定的實機驗證都在 CI（Linux）上做。

因此 `pnpm-workspace.yaml` 裡把 `workerd` 的安裝腳本關掉——開著會讓整個 `pnpm install` 直接失敗。CI 若需要那支執行檔，在部署 workflow 裡單獨處理。

**2. migration 的本機驗證用 `node:sqlite`。** D1 就是 SQLite，所以產生的 migration 可以直接用 Node 24 內建的 `node:sqlite` 套用驗證，不需要 workerd，也不必額外裝套件。
