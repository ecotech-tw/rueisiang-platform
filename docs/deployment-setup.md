# 第一次上線要開通什麼

這份文件講的是**帳號與資源的開通**——那些需要你本人的 Google 與 Cloudflare 帳號，
沒辦法由程式自己生出來。

平台已經在 <https://platform.rueisiang.com> 上跑，1–4 節與 5.2 都做完了。留著這份
文件是為了兩件事：換人接手時知道每個東西在哪、以及 5.1（R2）——**唯一還沒開通的
東西**。

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

> **儀表板的變更是「暫存」的，要按 Deploy 才會生效。** 分批新增時很容易漏按，
> 症狀是 Worker 讀到空值——這件事實際發生過一次，查了三輪才找到。

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

### 2.5 生出第一位管理者（只有全新環境需要）

正式環境已經做過這一步了，這節是給日後另開環境（例如 staging）時看的。

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

### 5.1 R2 — 倉位的現場照片 ❌ 還沒開通

沒開通的話，上傳照片會回「尚未設定照片儲存空間，請聯絡管理者」，地圖與庫存
其他功能完全正常。

```bash
npx wrangler r2 bucket create rueisiang-platform-uploads
```

bucket 名稱要跟 `apps/api/wrangler.toml` 的 `[[r2_buckets]]` 一致，binding 是
`UPLOADS`。**開通 R2 要在 Cloudflare 完成一次訂閱流程**（會要求留付款方式），
但用量在免費額度內是 $0：10 GB 儲存、流量不計費，而倉位照片撐死幾百 MB。

照片本身放 R2，D1 的 `zone_images` 只存索引（object key、檔名、大小）。讀取走
`/api/wms/images/:id` 而不是 R2 的公開網址——倉庫內部的照片，拿到連結的人不該
就看得到。

### 5.2 Upstash Redis — CYBERBIZ 商品目錄的快取 ✅ 已設定

**沿用舊 WMS 的同一個實例**，不必另外開。兩個值已經設成 Worker secret：

```
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

沒設定的話，「CYBERBIZ 庫存」那一頁每次開都會去翻官網的商品目錄（139 個款式
要翻 3 頁），慢幾秒但功能正常。

> Workers 開不了原生的 Redis 連線，但 Upstash 的 REST 端點只是一個 HTTPS 請求
> ——那正好是 Worker 唯一做得到的形式，所以舊系統那份程式碼直接就能用。

---

## 6. CYBERBIZ — webhook ⚠️ 要改成新網址

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

### 要做什麼

| # | 動作 | 為什麼 |
|---|---|---|
| 1 | 把現有的會員事件改設到 `/api/webhooks/cyberbiz` | 舊網址是 `/cyberbiz/customers`，名字看起來只收客戶，實際上收全部 |
| 2 | **新增訂閱 `variants/update`** 到同一個網址 | ⚠️ 這個之前根本沒訂，官網改庫存平台不會知道 |

密鑰不用動——沿用 Worker secret `CYBERBIZ_WEBHOOK_SECRET`。

> **舊網址 `/api/webhooks/cyberbiz/customers` 不會被移除。** 後台改設定跟程式
> 部署不可能同一秒發生，中間那段時間事件還是會從舊網址進來。它跟新網址走的是
> 同一段程式，包括分派——所以就算忘了改，商品事件一樣處理得到。

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
| 4 | 設五個 secret | Cloudflare 儀表板（2.3） | Worker 存在之後才有地方設 |
| 5 | 跑四行 SQL 生出第一位管理者 | D1 主控台（2.5） | 空資料庫沒有人能登入，只能從外面打破 |
| 6 | 登入，邀請其他同仁 | 瀏覽器 | 這時候才算真的上線 |
| 7 | 網域委派 | DNS（3） | 隨時可做，不擋前面任何一步 |

第 2 步的部署會成功但還不能登入——secret 是執行時才讀的，缺了不影響部署，
只有 `/api/auth/google/start` 會壞。`/api/health` 那時就該回 `"database":"ok"`。

| 步驟 | 需要誰 | 卡點 |
|---|---|---|
| Google OAuth client | 你（Workspace 管理者） | 同意畫面選內部還是外部，取決於同仁信箱網域 |
| Cloudflare 帳號與 D1 | 你 | 已完成 |
| R2 bucket（選用） | 你 | **還沒開通**。要走一次訂閱流程；用量在免費額度內是 $0 |
| Upstash secret（選用） | 你 | 已完成，用的是舊 WMS 的同一組值 |
| GitHub secret 與變數 | 你 | API token 的 D1 權限要手動加，範本沒有 |
| 部署 | GitHub Actions | 這台開發機連 `wrangler whoami` 都跑不了 |
| 網域委派 | 管 `rueisiang.com` DNS 的人 | 要確認現有記錄不會被弄斷 |
