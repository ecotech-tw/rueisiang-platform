# 第一次上線要開通什麼

Phase 1 的程式碼已經完成，剩下的是**帳號與資源的開通**——這些都需要你本人的 Google 與
Cloudflare 帳號，沒辦法由程式自己生出來。照著這份文件走一次，之後的部署就只是 `wrangler deploy`。

需要的東西一共三樣：**一個 Google OAuth client**、**一個 Cloudflare 帳號與 D1 資料庫**、
**一組網域設定**。

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
https://tools.rueisiang.com/api/auth/google/callback
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

### 2.1 建立資料庫 ✅ 已完成

D1 資料庫 `rueisiang-platform` 已經建好，`database_id` 也填進
`apps/api/wrangler.toml` 了。這個值不是機密，可以進版控。

（等價指令：`npx wrangler d1 create rueisiang-platform`）

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
| `SETUP_TOKEN` | 自己想一組長字串，只有第一次要 |
| `BOOTSTRAP_ADMIN_EMAIL` | 你自己的公司信箱，只有第一次要 |

`AUTH_SESSION_SECRET` 可以在本機這樣產生（這是純 Node，跑得起來）：

```bash
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

這把金鑰換掉會讓所有人的登入狀態失效（cookie 驗不過），所以之後不要隨手換。

secret 存進去就立即生效，不必重新部署；之後的部署也不會把它們洗掉。

（等價指令：`cd apps/api && npx wrangler secret put <名稱>`）

### 2.4 部署

**這一步不能在這台開發機做**——Windows on ARM 沒有 `workerd` 執行檔。用 GitHub Actions：
到 repo 的 **Actions 分頁 → Deploy → Run workflow**。先決條件是第 4 節的兩個 secret。

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

（若之後在 WSL 或別台 Linux 上要手動部署，指令是 `pnpm build` 之後
`cd apps/api && npx wrangler deploy`。）

### 2.5 初始化資料

全新的 D1 只有空表：`roles` 是空的、`users` 也是空的，等於沒有人拿得到權限、
也沒有人能登入去邀請別人。這一步就是打破這個死結：

```bash
curl -X POST https://<你的 worker 網址>/api/setup -H "X-Setup-Token: <剛才設的 SETUP_TOKEN>"
```

回應 `{"roles":"synced","bootstrap":"created"}` 就成功了。它做兩件事，都可以重複執行：

1. 把 `packages/auth/src/permissions.ts` 定義的四個角色與權限寫進資料庫
2. 系統完全沒有管理者時，用 `BOOTSTRAP_ADMIN_EMAIL` 建立第一位（狀態是「已邀請」）

跑完之後建議把憑證刪掉，那條路由就等同不存在：儀表板的
**Variables and Secrets** 裡把 `SETUP_TOKEN` 刪除即可
（等價指令：`npx wrangler secret delete SETUP_TOKEN`）。

**日後改了 `permissions.ts` 要重新同步**：設回 `SETUP_TOKEN`、部署、再打一次
`/api/setup`、刪掉。角色的權限清單是整組重寫，所以增減權限都會生效。

### 2.6 確認

```bash
curl https://<你的 worker 網址>/api/health
```

看到 `{"status":"ok","database":"ok",...}` 代表 Worker 活著而且 D1 綁定接上了。

接著用瀏覽器開首頁 → 用 `BOOTSTRAP_ADMIN_EMAIL` 那個 Google 帳號登入 →
進「系統管理 / 權限管理」邀請其他同仁。第一次登入會把你的狀態從「已邀請」轉成「啟用中」。

---

## 3. 網域 — tools.rueisiang.com

`rueisiang.com` 的 DNS 要指到 Cloudflare 才能綁自訂網域。兩種做法：

**A. 整個網域搬進 Cloudflare**（Cloudflare 官方建議，也最單純）
在 Cloudflare 加入 `rueisiang.com`，把 name server 改成 Cloudflare 給的兩支。
其他既有的 DNS 記錄要先確認都搬過去，不然官網或信箱會斷。

**B. 只委派子網域**
在現有的 DNS 服務商把 `tools.rueisiang.com` 的 NS 記錄指向 Cloudflare。
影響範圍只有這個子網域，其餘不動——如果官網的 DNS 由別人管，這個選項比較安全。

任一種完成之後，把 `apps/api/wrangler.toml` 裡這段的註解拿掉再部署一次：

```toml
[[routes]]
pattern = "tools.rueisiang.com"
custom_domain = true
```

然後回到 1.2，確認 Google 的重新導向 URI 有 `tools.rueisiang.com` 那一條。

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

`deploy.yml` 目前只能手動觸發，這樣在第一次上線、secret 還沒齊之前不會一直寄失敗通知。
順利跑過一次之後，把檔案開頭註解裡的那三行 `push: branches: [main]` 加進 `on:`，
推上 main 就會自動部署。

另外 `ci.yml` 不需要任何 secret，每次推送與 PR 都會跑型別檢查、測試、build，
最後在 Linux 上跑一次 `wrangler deploy --dry-run`——這台開發機驗不到的
「wrangler.toml 到底能不能部署」，只有在那裡才驗得到。

---

## 執行順序

文件的章節是照主題分的，實際動手的順序不一樣——**先部署一次**，因為在那之前
Worker 還不存在（沒地方放 secret），而且它的網址也還不知道。

| # | 做什麼 | 在哪裡 | 為什麼是這個順序 |
|---|---|---|---|
| 1 | 加 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | GitHub（4.1） | 部署的前提 |
| 2 | 跑 Deploy workflow | GitHub Actions（2.4） | 建出 Worker，**輸出會印出 workers.dev 網址** |
| 3 | 用第 2 步的網址建 Google OAuth client | Google Cloud（1） | 重新導向 URI 需要那個網址 |
| 4 | 設五個 secret | Cloudflare 儀表板（2.3） | Worker 存在之後才有地方設 |
| 5 | `curl -X POST .../api/setup` | 終端機（2.5） | 寫入角色、建立第一位管理者 |
| 6 | 登入，邀請其他同仁 | 瀏覽器 | 這時候才算真的上線 |
| 7 | 網域委派 | DNS（3） | 隨時可做，不擋前面任何一步 |

第 2 步的部署會成功但還不能登入——secret 是執行時才讀的，缺了不影響部署，
只有 `/api/auth/google/start` 會壞。`/api/health` 那時就該回 `"database":"ok"`。

| 步驟 | 需要誰 | 卡點 |
|---|---|---|
| Google OAuth client | 你（Workspace 管理者） | 同意畫面選內部還是外部，取決於同仁信箱網域 |
| Cloudflare 帳號與 D1 | 你 | 已完成 |
| GitHub secret 與變數 | 你 | API token 的 D1 權限要手動加，範本沒有 |
| 部署 | GitHub Actions | 這台開發機連 `wrangler whoami` 都跑不了 |
| 網域委派 | 管 `rueisiang.com` DNS 的人 | 要確認現有記錄不會被弄斷 |
