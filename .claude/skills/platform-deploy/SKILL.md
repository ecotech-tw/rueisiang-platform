---
name: platform-deploy
description: 開通與維運瑞香平台在 Cloudflare 上的資源：建立 Worker 與 D1、設定 Queue、Worker secret 與模型 provider credential、跑 Deploy workflow、綁定 platform.rueisiang.com、產生第一位管理者、設定 GitHub Actions 部署憑證、開通 R2 與 Upstash，以及 CYBERBIZ webhook。用於首次上線、另開環境（staging）、換人接手、憑證過期要重設、部署失敗或回滾、確認某個 secret 該填什麼值。
---

# 開通與部署瑞香平台

**這是操作手冊，不是架構說明。** 講的是那些需要人本人的 Google 與 Cloudflare 帳號、
沒辦法由程式自己生出來的東西。系統長什麼樣看 `README.md` 與 `docs/`。

正式站在 <https://platform.rueisiang.com>。**要動手之前先看最後一節「執行順序」**——
本文的章節照主題分，實際操作順序不一樣（要先部署一次，Worker 才存在）。

> **狀態不寫在這份文件裡。** 哪些資源已經開通、哪些還沒，去 Cloudflare 儀表板與
> GitHub Secrets 看，那才是真的。文件只講「怎麼開」與「為什麼是這樣開」。

---

## 1. Google Cloud — OAuth client

登入 <https://console.cloud.google.com/>，選一個專案（沿用 CRM 或 WMS 現在用的那個也可以，
省得再設定一次同意畫面）。

### 1.1 OAuth 同意畫面

「API 和服務」→「OAuth 同意畫面」：

| 欄位 | 填什麼 |
|---|---|
| User type | **內部（Internal）** |
| 應用程式名稱 | 瑞香內部系統 |
| 使用者支援電子郵件 | 你的公司信箱 |
| 授權網域 | `rueisiang.com` |

選「內部」的理由：ecotech.tw 是 Google Workspace，內部應用不需要送 Google 審查，
也不會出現「這個應用程式未經驗證」的警告頁。代價是只有同網域的帳號能登入——
對內部系統來說這正是想要的。

> 如果同仁的信箱不在同一個 Workspace 網域下，這裡就得改成「外部」，
> 那會多一道審查流程。先確認名單再決定。

### 1.2 建立 client

「憑證」→「建立憑證」→「OAuth 用戶端 ID」→ 類型選 **網頁應用程式**。

**已授權的重新導向 URI** 要填兩條：正式網域一條，workers.dev 一條
（網域還沒委派之前就是靠後者測）。

```
https://platform.rueisiang.com/api/auth/google/callback
https://rueisiang-platform.<你的帳號子網域>.workers.dev/api/auth/google/callback
```

`rueisiang-platform` 是 Worker 的名字，來自 `apps/api/wrangler.toml` 的 `name`，
這個不會變。**`<你的帳號子網域>` 則是 Cloudflare 帳號層級的設定，猜不出來**，
三個地方都看得到：

1. 先跑一次 2.4 的部署，輸出會直接印出完整網址（最省事）
2. Cloudflare 儀表板 → Compute (Workers) → 右側資訊欄的 `xxx.workers.dev`
3. 部署完之後 Worker 頁面上的網址

如果你的帳號從來沒用過 Workers，第一次部署時 Cloudflare 會要你挑一個子網域，
挑完就固定了。

路徑部分必須**一字不差**——程式換 token 時會把同一個 URL 再送一次，
Google 會逐字比對（`apps/api/src/routes/auth.ts` 的 `CALLBACK_PATH`）。
結尾沒有斜線，`http` 不行、大小寫也要一致。

建完會拿到 **用戶端 ID** 與 **用戶端密鑰**，下一節要用。程式要的 scope 是
`openid email profile`，這是預設值，不必另外開通任何 API。

---

## 2. Cloudflare — Worker 與 D1

需要一個 Cloudflare 帳號（免費方案就夠）。

> **這台開發機不能執行任何 wrangler 指令。** Windows on ARM 沒有 workerd 執行檔，
> 而 wrangler 一啟動就會載入它——`whoami`、`secret put`、`d1 create` 全都會直接
> 拋 `Unsupported platform: win32 arm64 LE`，不是只有 `dev` 和 `deploy` 而已。
>
> 所以底下用**儀表板**操作。如果你手上有 WSL 或別台 Linux/macOS，
> 括號裡的 wrangler 指令是等價的做法。

### 2.1 建立資料庫

建一個叫 `rueisiang-platform` 的 D1，把拿到的 `database_id` 填進
`apps/api/wrangler.toml`。這個值不是機密，可以進版控。

（等價指令：`npx wrangler d1 create rueisiang-platform`）

### 2.1.1 建立 LINE Queue

LINE webhook 的 AI 工作會寫入 `rueisiang-line-assistant`，由同一個 Worker 的 Queue
consumer 執行；正式回覆優先走 LINE Reply API，逾時結果才使用受限 Push。這個 Queue 只需要建立一次，名稱要跟
`apps/api/wrangler.toml` 的 `[[queues.producers]]` 與 `[[queues.consumers]]` 一致。

consumer 設定了 `rueisiang-line-assistant-dlq` 作為 dead-letter queue；達到重試次數仍失敗的工作會保留在那裡，
方便到 Cloudflare Queues 儀表板依 `webhookEventId` / `runId` 追查，不會直接消失。D1 outbox 同步把耗盡重試的工作標為
`failed`，避免 scheduled drain 再次建立獨立投遞；LINE Push retry key 超過 24 小時則標為 `ambiguous`，不自動重送。

Cloudflare 儀表板：**Storage & Databases → Queues → Create queue**，建立
`rueisiang-line-assistant`。

（等價指令：`npx wrangler queues create rueisiang-line-assistant`；本機 Windows on ARM
不能執行，請用儀表板、WSL 或 Linux/CI。）

Queue consumer 設定 `max_concurrency = 1`，讓 LINE 工作依序完成，避免同一群組／聊天室的訊息
因為慢 tool 而交錯回覆；D1 的 Push fixed-window ledger 仍以單一原子 `INSERT ... SELECT`
預約收件人數，額度正確性不依賴 consumer 的串行化。

### 2.1.2 設定 LINE Messaging API

在 LINE Developers Console 準備一個 Messaging API channel，並取得：

- Channel ID
- Channel secret
- Channel access token

Webhook URL 設為 `https://platform.rueisiang.com/api/webhooks/line`，開啟 **Use webhook**。
部署後可在平台的「小香助理 → LINE 前台」輸入三個值；secret 與 access token 會加密存入
D1，也可用同名 Worker secret 當 fallback。Push API 不需另開一個 channel 或 token，沿用同一個
Messaging API access token；LINE 官方帳號的自動回覆若會干擾測試，請在 Official Account
Manager 關閉或調整。

系統仍以 Reply token 為主。只有推論接近期限或 Reply 失敗時才嘗試 Push，並依 LINE 計費時區
GMT+9 使用每月 fixed window；免費方案硬上限為 200 位收件者，群組訊息按群組成員數計算。
額度、成員數任一查不到就不 Push，回答改存 D1 備用紀錄。

### 2.1.3 設定小香 Pi Agent 與模型 provider

LINE Queue consumer 與 Sandbox API 都會把對話 dispatch 到 SQLite Durable Object，由 Pi Agent
執行模型、tools、session transcript 與 compact。GPT 模型使用 Codex ChatGPT OAuth；Gemini 模型
使用 API key。`wrangler deploy` 會依 `apps/api/wrangler.toml` 的 migration 建立
`AssistantChatAgent` 與 `AssistantCredentialVault`，不需要在 Cloudflare Dashboard 手動建立
DO instance。

部署後還要設定 `PI_OPENAI_CODEX_CREDENTIAL` 與 `PI_CREDENTIAL_ENCRYPTION_KEY`。如何從
Codex CLI 取得最小 credential JSON、vault 如何加密／refresh，以及 session／compact／reset
行為，完整說明見 [`docs/line-pi-agent.md`](../../../docs/line-pi-agent.md)。Codex 路徑不使用
`OPENAI_API_KEY`；要開 Gemini 模型才需要 `GEMINI_API_KEY`。兩個 provider 可只設定其中一個，
但目前 active model 對應的 credential 必須存在。

### 2.1.4 設定 NAS 媒體儲存（可選）

`tools/nas-storage` 是獨立的 Node gateway，NAS 只透過 Cloudflare Tunnel 提供受驗證的 HTTPS
物件操作，不把 NAS 絕對路徑或共用資料夾公開給 Worker。WMS 同時支援兩種來源：設定 NAS 後，
新照片寫入 `wms/zones/...`；既有 `zones/...` 的 R2 object key 仍然可以讀取與刪除，因此可以
先做小範圍 smoke test，再安排舊檔案 migration。

Worker 端必須同時設定 `NAS_STORAGE_URL` 與 `NAS_STORAGE_TOKEN`；只設定其中一個會以設定錯誤
拒絕圖片操作。token 要和 Codex relay 使用不同的值。gateway 的 NAS 建置、權限、Tunnel
hostname 與回滾步驟見 [`tools/nas-storage/README.md`](../../../tools/nas-storage/README.md)。

`NAS_STORAGE_URL` 只填 gateway 的 HTTPS origin，不要加 API path：

```text
正確： https://storage.rueisiang.com
錯誤： https://storage.rueisiang.com/v1/objects
```

Worker 會自行把 `/v1/objects` 加到 URL；gateway 的健康檢查是
`GET /healthz`，物件上傳、讀取與刪除則使用帶 `x-storage-token` 的 `/v1/objects`。

### 2.2 套用 migration — 不用手動做

`deploy.yml` 每次部署都會執行 `wrangler d1 migrations apply --remote`，
而且排在部署之前。已經套用過的 migration 不會重複執行。

### 2.3 設定 secret

**要等第一次部署之後**——Worker 還不存在的時候，儀表板上沒有地方可以放這些值。
所以真正的順序是「先部署（2.4）→ 回來設 secret → 再初始化（2.5）」。
第一次部署不會因為缺少這些 secret 而失敗，它們是執行時才讀的。

Cloudflare 儀表板 → **Compute (Workers)** → `rueisiang-platform` →
**Settings** → **Variables and Secrets** → Add，型別選 **Secret**：

| 名稱 | 值 |
|---|---|
| `AUTH_SESSION_SECRET` | 一串夠長的亂數，見下方 |
| `GOOGLE_OAUTH_CLIENT_ID` | 1.2 拿到的用戶端 ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | 1.2 拿到的用戶端密鑰 |
| `GEMINI_API_KEY` | Pi Google provider 的 Gemini API key；Sandbox 與 LINE 選 Gemini 模型時使用 |
| `PI_OPENAI_CODEX_CREDENTIAL` | Codex CLI 或 Pi 的 ChatGPT OAuth credential JSON；不是 OpenAI API key |
| `PI_CREDENTIAL_ENCRYPTION_KEY` | 至少 32 字元；加密 credential-vault 內的 access／refresh token |
| `PI_OPENAI_CODEX_RELAY_TOKEN` | 可選；NAS Codex relay 的 shared token，搭配 `wrangler.toml` 裡的 `PI_OPENAI_CODEX_RELAY_URL` 使用 |
| `NAS_STORAGE_TOKEN` | NAS storage gateway 的獨立 shared token；搭配 `NAS_STORAGE_URL` 使用 |
| `CYBERBIZ_REPORT_INGEST_TOKEN` | GitHub Actions runner 將驗證後的 CYBERBIZ 每日資料寫入 D1 的獨立 shared token |
| `CYBERBIZ_REPORT_MCP_TOKEN` | 只讀 CYBERBIZ reports MCP endpoint 的獨立 bearer token；不要與 NAS 或 ingest token 共用 |
| `LINE_CHANNEL_SECRET` | 選用 fallback；LINE Developers 的 Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | 選用 fallback；同一個 token 同時供 Reply 與受限 Push 使用 |

> **儀表板的變更是「暫存」的，要按 Deploy 才會生效。** 分批新增時很容易漏按，
> 症狀是 Worker 讀到空值——這件事實際發生過一次，查了三輪才找到。

`AUTH_SESSION_SECRET` 可以在本機這樣產生（這是純 Node，跑得起來）：

```bash
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

這把金鑰換掉會讓所有人的登入狀態失效（cookie 驗不過），所以之後不要隨手換。

secret 存進去就立即生效，不必重新部署；之後的部署也不會把它們洗掉。非機密的 relay URL 與
`NAS_STORAGE_URL` 則寫在 `apps/api/wrangler.toml` 的 `[vars]`，避免只存在 Dashboard 而被
下一次 Wrangler 部署覆蓋；目前正式 hostname 為 `https://storage.rueisiang.com`。

（等價指令：`cd apps/api && npx wrangler secret put <名稱>`）

### 2.3.1 CYBERBIZ 報表 runner

後台的「CYBERBIZ 商品銷售報表」會 dispatch GitHub Actions 的
`.github/workflows/cyberbiz-sales-report.yml`。它預設沿用 `PAYOUT_GITHUB_REPO`；只有要放到不同
repository 時，才在 `apps/api/wrangler.toml` 的 `[vars]` 設定 `CYBERBIZ_SALES_GITHUB_REPO`。
workflow 檔名與 branch 可用 `CYBERBIZ_SALES_WORKFLOW_FILE`、`CYBERBIZ_SALES_GITHUB_REF` 覆寫。

出金與商品銷售兩個 workflow 都需要在 GitHub Actions secrets 設定：

- `CYBERBIZ_USERNAME`、`CYBERBIZ_PASSWORD`
- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`
- `GMAIL_REFRESH_TOKEN`

完整月份若要建立可供 AI 查詢的每日資料，只需要 `CYBERBIZ_REPORT_INGEST_TOKEN`；報表 runner
不需要 NAS，也不需要 `PLATFORM_API_URL` secret。缺少 ingest token 時仍會照常匯出、驗證並上傳
原始 XLSX 到 Google Drive，只是不匯入 D1；補上 token 後重新執行即可。`PLATFORM_API_URL`
不是 secret，只有 runner 要寫入不同 Worker URL 時才用 repository variable `WORKER_URL` 覆寫，
未設定時 fallback 到 `https://platform.rueisiang.com`。自訂日期區間只上傳原始 XLSX 到 Google Drive，
不會匯入 D1。
Google Drive 的 root 與各店別資料夾設定方式，沿用
[`cyberbiz-reports` skill](../cyberbiz-reports/SKILL.md)。

### 2.4 部署

**這一步不能在這台開發機做**——Windows on ARM 沒有 `workerd` 執行檔。用 GitHub Actions：
到 repo 的 **Actions 分頁 → Deploy → Run workflow**，並選擇 `main`。先決條件是第 4 節的兩個 secret。

正式環境的 Worker 與 Portal assets 必須由同一次 `main` Deploy workflow 發佈。不要從
未同步的 worktree、Cloudflare Dashboard 的舊版編輯器或其他分支直接執行 `wrangler deploy`；
這會讓 API Worker 與 Portal assets 不在同一個版本。

workflow 的順序是：安裝 → 型別檢查 → 測試 → build → 套用 D1 migration → 部署 → 健康檢查。
migration 排在部署之前，因為新欄位要在讀它的程式上線之前就存在。

**這是整個流程裡第一個該做的動作**，即使 secret 都還沒設、Google client 也還沒建。
理由是部署的輸出會印出這個 Worker 的正式網址：

```
Deployed rueisiang-platform triggers (0.52 sec)
  https://rueisiang-platform.<你的帳號子網域>.workers.dev
```

那串 `<你的帳號子網域>` 不是可以自己猜的——它是 Cloudflare 帳號層級的設定，
每個帳號一組。1.2 的重新導向 URI 和 4.2 的 `WORKER_URL` 都要用到它，
先部署一次就一次拿到，不必去別的地方翻。

部署輸出中的 `Current Version ID` 是這次 Worker 版本的核對值。Cloudflare Workers
Observability log 裡的 `$workers.scriptVersion.id` 應該與它一致；若不一致，先確認流量是否
仍在 rollout，再從 `main` 重新執行 Deploy workflow 或使用同一個版本 rollback。

若之後在 WSL 或別台 Linux 上要手動部署，必須先切到與 production 相同的 `main` commit，
再依序執行 `pnpm build`、`cd apps/api && npx wrangler d1 migrations apply rueisiang-platform --remote`
與 `npx wrangler deploy`。正式環境仍以 GitHub Actions Deploy 為準。

### 2.5 生出第一位管理者（只有全新環境需要）

**只有全新的資料庫要做這一步。** 既有環境重跑會被 `ON CONFLICT DO NOTHING` 擋掉，
不會壞，但也沒有意義。

全新的 D1 只有 migration 建出來的空表：`roles` 是空的（沒有人拿得到權限）、
`users` 也是空的（邀請制，沒有人能登入）。這是個死結，只能從資料庫外面打破。

到 **Storage & Databases → D1 → 你的資料庫 → Console**，把信箱換成你自己的之後執行：

```sql
INSERT INTO roles (id, key, name, is_system) VALUES ('role-admin', 'admin', '管理者', 1)
  ON CONFLICT(key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission) VALUES
  ('role-admin', 'admin:user:read'), ('role-admin', 'admin:user:write'), ('role-admin', 'admin:role:write')
  ON CONFLICT DO NOTHING;
INSERT INTO users (id, email, invited_by) VALUES ('user-bootstrap', 'you@ecotech.tw', 'bootstrap')
  ON CONFLICT(email) DO NOTHING;
INSERT INTO user_roles (user_id, role_id, granted_by)
  SELECT id, 'role-admin', 'bootstrap' FROM users WHERE email = 'you@ecotech.tw'
  ON CONFLICT DO NOTHING;
```

刻意只塞三個 `admin:*` 權限，剛好夠這個人登入並進到權限管理頁。其餘的角色與權限
不必手寫——登入之後按一次「重新同步」，`permissions.ts` 的完整內容就會寫進資料庫。

這四行是唯一需要手動碰資料庫的地方，而且它們不依賴 `permissions.ts` 的內容，
所以日後權限怎麼增減都不會讓這段 SQL 過期。

**日後改了 `permissions.ts`**：部署之後到權限管理頁按「重新同步」即可，
那條端點需要 `admin:role:write`，沒有額外的 secret 要管理。

### 2.6 確認

```bash
curl https://<你的 worker 網址>/api/health
```

看到 `{"status":"ok","database":"ok",...}` 代表 Worker 活著而且 D1 綁定接上了。

登入正式平台後，再用 Sandbox 做一輪圖片 smoke test：

1. 開啟一個 Sandbox session，選擇一張 JPEG、PNG、WebP 或 GIF。
2. 在瀏覽器 Network 確認 `POST /api/assistant/sandbox/attachments` 回 `201`，回應的
   `attachment.key` 以 `assistant/vision/<chat-id>/` 開頭。
3. 在 NAS gateway log 確認對應的 `POST /v1/objects` 成功，接著圖片預覽的
   `GET /api/assistant/sandbox/attachments?key=...` 也應成功。

如果 `/api/health` 正常，但上述已存在的 API route 回 `{"error":"Not found"}`，先比對
該 request 的 `$workers.scriptVersion.id` 與 Deploy 輸出的 `Current Version ID`，不要先調整
NAS token、volume 或圖片格式。

接著用瀏覽器開首頁 → 用 2.5 那個信箱的 Google 帳號登入 →
進「系統管理 / 權限管理」邀請其他同仁。第一次登入會把你的狀態從「已邀請」轉成「啟用中」。

---

## 3. 網域 — platform.rueisiang.com

`rueisiang.com` 的 DNS 要在 Cloudflare 底下，這個網域才綁得上。

**不要手動加 DNS 記錄。** `wrangler.toml` 裡的 `custom_domain = true` 會讓 Cloudflare
自己建立對應的記錄並簽發憑證；那個主機名稱如果已經有一筆記錄存在，部署反而會失敗，
要先把它刪掉。

```toml
[[routes]]
pattern = "platform.rueisiang.com"
custom_domain = true
```

所以流程是：確認 `rueisiang.com` 這個 zone 在 Cloudflare 帳號底下 → 合併這個設定 →
跑 Deploy workflow → Cloudflare 建好記錄與憑證（通常幾分鐘內生效）。

憑證還在簽發時網址會短暫回 5xx 或憑證錯誤，這是正常的，等一下再試。

綁好之後記得回到 1.2，把 `https://platform.rueisiang.com/api/auth/google/callback`
加進 Google 的重新導向 URI——**在那之前不要把 workers.dev 那條刪掉**，
不然憑證還沒好的空窗期就沒有路可以登入了。

---

## 4. GitHub — 部署用的憑證

repo（`ecotech-tw/rueisiang-platform`）已經存在，不必新開。要加的是兩個 secret 與一個變數：
**Settings → Secrets and variables → Actions**。

### 4.1 Secrets

| 名稱 | 哪裡拿 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 儀表板 → 右上角個人資料 → API Tokens → Create Token |
| `CLOUDFLARE_ACCOUNT_ID` | 儀表板網址列 `dash.cloudflare.com/` 後面那串十六進位 |

建 API token 時從「**Edit Cloudflare Workers**」範本開始，**再手動加上 D1 的編輯權限**——
範本預設不含 D1，少了它 `d1 migrations apply` 會失敗。最後需要的權限是：

- Account → Workers Scripts → Edit
- Account → **D1 → Edit**
- Zone → Workers Routes → Edit（綁自訂網域之後才用得到）

這個 token 等同於部署權限，只放在 GitHub secret 裡，不要貼進任何檔案。

### 4.2 Variables — 不需要

不必設任何 repository variable。健康檢查的網址是從 `wrangler deploy` 的輸出直接抓的，
所以綁了自訂網域之後也會自動跟著換，沒有第二個地方要記得改。

部署完會 curl `<網址>/api/health`，回應裡沒有 `"database":"ok"` 就讓 workflow 失敗。

### 4.3 自動部署

**合併進 `main` 就會自動部署**，另外保留手動觸發（要重跑或回滾時用）。

之所以敢這樣掛：能進 main 的東西都得先過 PR 的 CI——型別檢查、測試、build，
外加在 Linux 上跑一次 `wrangler deploy --dry-run`。

**要回滾**：Cloudflare 儀表板的 Worker 頁面可以直接切回上一個版本，比 revert 再等
一輪 CI 快。之後再把 revert 的 PR 合進來讓程式碼跟線上一致。

另外 `ci.yml` 不需要任何 secret，每次推送與 PR 都會跑型別檢查、測試、build，
最後在 Linux 上跑一次 `wrangler deploy --dry-run`——這台開發機驗不到的
「wrangler.toml 到底能不能部署」，只有在那裡才驗得到。

---

## 5. 倉儲的兩個外部資源

兩個都是「沒有也能跑，只是少一塊」——不會讓系統起不來，而且有測試釘著這件事。

### 5.1 R2 — 倉位照片的 fallback（可選）

設定 NAS storage 後，新上傳的倉位照片會優先寫入 NAS；沒有 NAS 時才使用 R2。
兩種來源都由同一組 API 讀取，既有 R2 object key 仍可正常讀取與刪除。
如果兩種儲存都沒有設定，上傳照片才會回「尚未設定照片儲存空間，請聯絡管理者」。

```bash
npx wrangler r2 bucket create rueisiang-platform-uploads
```

bucket 名稱要跟 `apps/api/wrangler.toml` 的 `[[r2_buckets]]` 一致，binding 是
`UPLOADS`。**開通 R2 要在 Cloudflare 完成一次訂閱流程**（會要求留付款方式），
但用量在免費額度內是 $0：10 GB 儲存、流量不計費，而倉位照片撐死幾百 MB。

使用 R2 fallback 時，照片本身放 R2；D1 的 `zone_images` 只存索引（object key、檔名、大小）。
讀取走 `/api/wms/images/:id` 而不是 R2 的公開網址——倉庫內部的照片，拿到連結的人不該
就看得到。R2 bucket 仍可依需求建立，不是 NAS storage 的必要條件。

### 5.2 Upstash Redis — CYBERBIZ 商品目錄的快取（可選）

平台使用一個 Upstash Redis 實例作為選用快取。開一個實例，把兩個值設成 Worker secret：

```
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

沒設定的話，「CYBERBIZ 庫存」那一頁每次開都會去翻官網的商品目錄（139 個款式
要翻 3 頁），慢幾秒但功能正常。

> Workers 開不了原生的 Redis 連線，但 Upstash 的 REST 端點只是一個 HTTPS 請求
> ——那正好是 Worker 唯一做得到的形式，所以平台可以直接使用這個快取服務。

---

## 6. CYBERBIZ — webhook

**一個網址收全部的事件。**

```
https://platform.rueisiang.com/api/webhooks/cyberbiz
```

CYBERBIZ 後台把**所有**要送到平台的事件都設到這一個位址就好——會員的、商品
款式的、以後如果還有別的。進來之後由程式判斷是什麼事件、分派到對應的處理函式。

| 事件 | 進來之後 |
|---|---|
| 會員註冊、會員修改、會員 UID 資料新增／更新、更新會員標籤 | 寫客戶資料 |
| 商品款式更新（`variants/update`） | 回官網重讀庫存，寫進 WMS 已連結的品項 |

### 設定

CYBERBIZ 後台的會員與商品事件都送到上面的網址，平台會依事件內容分派到對應的
處理函式。密鑰使用 Worker secret `CYBERBIZ_WEBHOOK_SECRET`。

### 為什麼是一個網址而不是每種事件一個

後台的訂閱是人手動設的。每多一個網址就多一個「有沒有設到」的問題，而**設漏了
不會有任何錯誤訊息**——只會安靜地不同步。一個網址的話，只要它通了就全部都通了。

代價是程式要自己判斷「這是什麼事件」。那個判斷本來就跑不掉：CYBERBIZ 不一定
送 topic 標頭，就算分成好幾條路，每一條也還是得驗證自己收到的是不是該收的
（商品事件被寫成客戶這件事真的發生過，建出一位叫「★潤白養膚小皂」的客人）。

### 驗證方式

兩種都接受，CYBERBIZ 後台給哪一種都行：

- 共用密鑰：網址加 `?token=<密鑰>`，或 `Authorization: Bearer <密鑰>`
- HMAC-SHA256 簽章：`x-cyberbiz-hmac-sha256`（也吃 `x-cyberbiz-signature`、
  `x-hub-signature-256`；hex 與 base64 都認）

**確認有沒有接上**：用瀏覽器直接開那個網址（GET），會回 `configured: true/false`。

### 幾個刻意的行為

- **不採信事件裡的庫存數量**，一律拿 `product_id` 回官網重讀。事件只用來知道
  「哪個商品動了」——簽章只證明是 CYBERBIZ 送的，不證明那個數字現在還是對的
  （事件會延遲、會亂序）
- **處理失敗回 200**，並把事件存下來由 cron（每 15 分）補跑。回 5xx 只會讓
  CYBERBIZ 用掉重送次數，用完那筆事件就真的消失了，而我們手上其實還留著它
- **內容不是 JSON 回 400**。那是對方送錯，不是我們壞了；而且重送一份一樣壞的
  內容沒有意義

## 執行順序

文件的章節是照主題分的，實際動手的順序不一樣——**先部署一次**，因為在那之前
Worker 還不存在（沒地方放 secret），而且它的網址也還不知道。

| # | 做什麼 | 在哪裡 | 為什麼是這個順序 |
|---|---|---|---|
| 1 | 加 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | GitHub（4.1） | 部署的前提 |
| 2 | 跑 Deploy workflow | GitHub Actions（2.4） | 建出 Worker，**輸出會印出 workers.dev 網址** |
| 3 | 用第 2 步的網址建 Google OAuth client | Google Cloud（1） | 重新導向 URI 需要那個網址 |
| 4 | 設定必要 secret 與要啟用的模型 provider credential | Cloudflare 儀表板（2.3） | Worker 存在之後才有地方設 |
| 5 | 跑四行 SQL 生出第一位管理者 | D1 主控台（2.5） | 空資料庫沒有人能登入，只能從外面打破 |
| 6 | 登入，邀請其他同仁 | 瀏覽器 | 這時候才算真的上線 |
| 7 | 網域委派 | DNS（3） | 隨時可做，不擋前面任何一步 |

第 2 步的部署會成功但還不能登入——secret 是執行時才讀的，缺了不影響部署，
只有 `/api/auth/google/start` 會壞。`/api/health` 那時就該回 `"database":"ok"`。

| 步驟 | 需要誰 | 會卡在哪 |
|---|---|---|
| Google OAuth client | Workspace 管理者 | 同意畫面選內部還是外部，取決於同仁信箱網域 |
| Cloudflare 帳號與 D1 | Cloudflare 帳號持有者 | 免費方案就夠 |
| R2 bucket（選用） | Cloudflare 帳號持有者 | 要走一次訂閱流程（留付款方式）；用量在免費額度內是 $0 |
| Upstash secret（選用） | Cloudflare 帳號持有者 | 沒有也能跑，只是 CYBERBIZ 庫存頁慢幾秒 |
| GitHub secret 與變數 | repo 管理者 | API token 的 D1 權限要手動加，範本沒有 |
| 部署 | GitHub Actions | 這台開發機連 `wrangler whoami` 都跑不了 |
| 網域委派 | 管 `rueisiang.com` DNS 的人 | 要確認現有記錄不會被弄斷 |
