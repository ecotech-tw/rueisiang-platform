---
name: cyberbiz-monthly-payout
description: 每月把 CYBERBIZ 各 POS 商店（百貨專櫃、服務區）的「每日出金報表」匯出、從 Gmail 取回 xlsx、寫入對帳欄位（H 公司POS / I 櫃位POS / J 備註 / K 人員業績）後上傳到 Google Drive 通路銷售紀錄，並產出月結報告。用於出金表、每日出金報表、POS 紀錄下載、通路月結對帳、上傳雲端硬碟、月初帳務作業，以及維護 tools/cyberbiz-monthly-payout 底下的 driver。也涵蓋報表跑完之後小香怎麼查（商品銷售總表查詢、出金區間查詢、report manifest、NAS normalized JSON、cyberbiz-reports MCP endpoint）。
---

# CYBERBIZ 每月出金表

對應 SOP：`工作說明書/營運部門_行政助理_帳務_每月做帳流程作業.docx`「每月 1 號至 cyberbiz
後台下載 pos 紀錄 / 出金表上傳 google drive」，以及 `各通路對帳作業.docx` 3.1 的出金合計公式。

報表跑完之後，資料怎麼被小香查到（manifest、NAS JSON、兩個查詢 tool、MCP endpoint）
寫在 [`reference/report-query.md`](./reference/report-query.md)——查詢跟產表是同一條資料流
的兩半，要改其中一邊先看另一邊。

程式在 `tools/cyberbiz-monthly-payout/`。**它刻意不在 pnpm workspace 裡**——相依
Playwright，拉進 workspace 會讓每個人的 `pnpm install` 都扛一份只有 runner 用得到的
瀏覽器函式庫。它用自己的 `npm ci`。

## 三個地方，各自負責什麼

搞混這件事會浪費最多時間，所以先講：

| 在哪 | 負責 | 碰得到憑證嗎 |
|---|---|---|
| 平台的「出金表執行」頁 | 同仁按執行、選區間、看進度 | 否 |
| 平台的 Worker（`apps/api/src/payout/github.ts`） | `workflow_dispatch` 觸發、查 run 狀態、把店別寫回 `stores.json` | 否，只有一顆 GitHub PAT |
| GitHub Actions runner（`.github/workflows/payout.yml`） | 真的跑 `driver.mjs`：開 Chrome、登 CYBERBIZ、讀 Gmail、寫 Drive | 是，全部 |

**Worker 不跑這個流程。** 它有執行時間上限，而一趟要三分半。

憑證掛在哪個 Google 帳號、怎麼重新產生——寫在 README 的「出金表：它跑在哪、憑證從哪來」，
這裡不重複，免得兩邊漂移。

## 同仁怎麼跑

平台 → 營運工具 → **出金表執行**。選區間、按「全部執行」或單店的「執行」。

- 需要 `tools:payout:run` 權限
- 送出後可以直接關掉頁面：執行在 runner 上，不需要任何人的電腦開機
- `concurrency: payout` 確保同時只有一個在跑
- runner 在美國，CYBERBIZ 每次都會要 2FA 驗證碼——由 Gmail API 自動讀取，不需要人介入
- 跑完報告貼在 Actions 的執行摘要，xlsx 與報告在 Artifacts（保留 30 天）

也可以直接到 Actions → 出金表月結 → Run workflow，那是同一條路。

## 店別清單有兩個來源

| 檔案 | 誰維護 | 內容 |
|---|---|---|
| `config.json` | 維護者（改 code 的人） | CYBERBIZ 網址、Drive 根目錄、欄位公式、**預設店別** |
| `stores.json` | 同仁（平台的「店別設定」頁） | 只有店別清單 |

`loadConfig` 讀到 `stores.json` 就以它為準；沒有那個檔案、或裡面是空清單時照
`config.json` 走；JSON 壞掉會直接報錯，不默默跑舊的。

**店名必須與 CYBERBIZ 後台完全一致**，driver 靠它找店。用 `node driver.mjs --list-stores`
對。在平台上新增一家後台沒有的店，執行時會 `STORE_NOT_FOUND`。

## 本機怎麼跑

```bash
cd tools/cyberbiz-monthly-payout
npm ci
node driver.mjs
```

不給參數＝上個月（Asia/Taipei）＋設定裡所有店。以下都在工具目錄執行：

```bash
node driver.mjs --month 2026-07                        # 指定月份（整個月）
node driver.mjs --start 2026-07-05 --end 2026-07-20    # 指定起訖日，兩個要一起給
node driver.mjs --store 宏匯廣場1F                       # 只跑一家，可重複給
node driver.mjs --skip-upload                          # 只到「加欄位」為止，不碰 Drive
node driver.mjs --list-stores                          # 印出後台所有 POS 商店後結束
node driver.mjs --headless                             # 不開視窗（CI 用這個）
node driver.mjs --help
```

`--month` 與 `--start/--end` 只能擇一。產出：

- 終端摘要：每家一行「匯出 / 取檔 / 驗證 / 加欄位 / 上傳」＋出金合計＋試算表連結
- `reports/YYYY-MM-出金表.md`：同內容 ＋ 未完成清單 ＋ 待人工處理事項
- `staging/YYYY-MM/`：已寫入欄位的 xlsx（就是上傳的那份）
- 失敗時 `screenshots/YYYY-MM-<店名>-error.png`

`YYYY-MM` 是區間標籤：剛好整月就是月份，否則變成 `YYYY-MM-DD~YYYY-MM-DD`。

**單店失敗不中斷其他店**；有任何一家沒完成，exit code 為 1。

## 欄位規則

出金表原始欄位是 A 關帳時間、B 入庫金額、C 零用金變化、D 收入類型、E 收入金額、
F POS機、G 操作人員（標題在第 2 列，資料從第 3 列起）。技能對**每一家店**都補上：

| 欄 | 標題 | 內容 |
| --- | --- | --- |
| H | 公司POS | 陣列公式，在每一日最後一列算出該日 E 欄合計，資料結束後一列是總計 |
| I | 櫃位POS | 留白，人工填專櫃自己的 POS 金額 |
| J | 備註 | 留白，有差異時寫原因 |
| K | 人員業績 | 陣列公式，列出操作人員並加總各人的 I 欄金額；**輸出兩欄**（K 人名、L 金額） |

K 欄公式會排除空值、「代班」與標題列「操作人員」。因為它加總的是 I 欄，
**I 欄填好之前 L 欄都是 0**，這是正常的。

跑完之後人工只要做兩件事：填 I 欄、必要時寫 J 欄。H 與 K 是公式，不要手動改。

## 改程式之前先跑自我檢查

```bash
cd tools/cyberbiz-monthly-payout
node selftest.mjs
```

不需帳密、不開瀏覽器、不打網路。涵蓋日期推算（跨年、閏年、台北時區邊界）、附件檔名規則、
xlsx 解析（含自閉合空儲存格）、月份守門、機密遮蔽、欄位注入與重跑冪等、報告產出、config
完整性。測試項目會隨回歸案例增加，不在文件寫死數量；完成時應全部通過。

## Gotchas

這些都是實際踩過的：

- **Google 擋自動化瀏覽器登入**。Playwright 開的 Chrome 一登入 Google 就出現
  「This browser or app may not be secure」。所以 (1) OAuth 授權頁一律用系統預設瀏覽器開，
  (2) Gmail 完全走 API，瀏覽器只用來操作 CYBERBIZ 後台。
- **Windows 上不能用 `cmd /c start` 開授權網址**。網址裡的 `&` 會被 cmd 當成命令分隔符，
  網址被截斷後 Google 回 `400 invalid_request`（缺 response_type）。改用
  `rundll32 url.dll,FileProtocolHandler`。
- **OAuth 一定要帶 `prompt=consent select_account`**。瀏覽器已登入別的 Google 帳號時，
  Google 會直接沿用那個帳號不問，token 就綁錯信箱（第一次就綁到 rueisiang 而不是 eli-lin）。
  `setup.mjs mail` 事後會比對授權到的信箱，不符會提示重跑。
- **POS 商店列表是 DataTable，預設一頁 10 筆，實際有 13 家**。不展開就會漏掉台南新光西門、
  仁德南/北服務區。`expandTable()` 會把每頁筆數切到最大，並用「Showing X of N」數字核對，
  對不上就丟 `STORE_LIST_TRUNCATED`。
- **CYBERBIZ 匯出的 xlsx 有自閉合空儲存格** `<c r="B1" s="0" />`。用「屬性＋選擇性內容」
  的正規式解析會讓空格吃掉下一格的值，整列錯位（症狀：A2 變空、標題跑到 E1）。
  `tools/cyberbiz-monthly-payout/lib/xlsx.mjs` 的 cell 正規式必須把自閉合情況分開處理，selftest 有回歸測試。
- **樣式索引是每個檔案自己的，不能寫死**。這份匯出的 `styles.xml` 裡 `s="3"` 是
  粗體＋灰底 `FFE5E5E8` 的標題樣式、`s="4"` 是一般資料樣式。早期版本把公式格寫成 `s="3"`，
  結果算出來的數字整欄看起來像標題列。現在標題格的樣式是從檔案現有標題列抄的，
  公式格預設不寫 `s` 屬性。
- **公式不要加 `_xlfn.` 前綴**。`UNIQUE`/`FILTER` 在 xlsx 規格上屬於新函式，理論上要寫成
  `_xlfn.UNIQUE` / `_xlfn._xlws.FILTER`，但實測 Google Sheets 讀到那種寫法會變 `#NAME?`；
  直接寫 `UNIQUE(...)` / `FILTER(...)` 反而正常運算。三種寫法都實際上傳轉檔測過。
- **公式範圍一定要超出最後一列資料**。最後一天要跟「下一列（空白）」比對日期才會被判定為
  當日最後一列，總計列也靠 `MATCH(...)+3` 落在資料後面。範圍剛好切在最後一列，
  最後一天與總計都會消失。沿用生產檔做法固定到第 1000 列。
- **維持 xlsx，不要轉成 Google 原生試算表**。Drive 上既有的出金表都是 xlsx，H3 存的是
  xlsx 陣列公式 `<f t="array" ref="H3:H1000">`，Google Sheets 開啟時會運算。轉成原生格式
  會跟歷史檔案不一致（也因此 Sheets API 讀不了這些檔，要驗算得先複製轉檔）。
- **2FA 記得勾「記住此裝置 30 天」**。`login()` 會自動勾，配合持久化的 `chrome-profile/`，
  接下來 30 天內不必再等驗證信。
- **Chrome profile 不能同時被兩個行程開啟**。上次跑的視窗沒關就再跑會直接啟動失敗；
  workflow 的 `concurrency: payout` 因此確保同時只有一個執行。
- **OAuth 應用程式若停在「測試中」，refresh token 只有 7 天壽命**（外部使用者類型）。
  到期後所有 Google API 呼叫回 `invalid_grant`。必須把發布狀態改成「正式版」再重新授權一次；
  改狀態不會延長已發出的 token，一定要重跑 `setup.mjs auth` 與 `setup.mjs mail`。
- **同名檔案不覆寫**。Drive 已有同名檔就跳過並在報告註明，避免洗掉人工已填的 I/J 欄。
  要重做請先在 Drive 改名或刪掉。
- **匯出是非同步寄信**，不是即時下載。取檔最多等 3 分鐘，附件只認匯出送出時間之後的信，
  不會抓到上個月同名的舊報表。
- **機密不落地**。密碼與 6 碼驗證碼寫進 log 或報告前都會過 `redact()`；
  `tools/cyberbiz-monthly-payout/` 下的 `.env`、`chrome-profile/`、`staging/`、`reports/`、`screenshots/`
  都在 `.gitignore` 裡。

## Troubleshooting

| 症狀 | 處理 |
| --- | --- |
| `信箱或密碼錯誤`（LOGIN_FAILED） | `.env` 的帳密不對。注意後台帳號未必等於收信信箱 |
| `OTP_TIMEOUT` | 驗證信搜不到。目前條件是 `from:noreply@cyberbiz.co subject:驗證碼 newer_than:1h`，寄件者或主旨改了就要調 `tools/cyberbiz-monthly-payout/config.json` |
| `GMAIL_FORBIDDEN` / 403 | Gmail API 沒啟用，或授權帳號不在測試使用者名單 |
| `STORE_LIST_TRUNCATED` | 商店列表分頁沒展開，看 `expandTable()` |
| `STORE_NOT_FOUND` | `tools/cyberbiz-monthly-payout/config.json` 店名要與後台**完全一致**，用 `--list-stores` 對 |
| `DATE_REVERTED` | datepicker 行為變了，看 `tools/cyberbiz-monthly-payout/lib/cyberbiz.mjs` 的 `chooseDate` |
| `EMAIL_TIMEOUT` | 信還沒到，稍後用 `--store <該店>` 單獨補跑 |
| `RANGE_MISMATCH` / `HEADER_MISMATCH` | 下載到的檔結構或月份不對，先看 `tools/cyberbiz-monthly-payout/staging/` 那份檔 |
| `FORMULA_NOT_EVALUATED` | 上傳後轉檔驗算不出值，多半是欄位注入寫壞了 |
| `GOOGLE_API_ERROR` 401/403、`invalid_grant` | token 失效。先確認 OAuth 應用程式是「正式版」而非「測試中」，再重跑 `node setup.mjs auth` 與 `mail` |
| 平台上按了執行沒動靜 | 已有工作在跑（`concurrency: payout`，一次只跑一個），等前一個結束；或到 Actions 看那次 run 的 log |
| 平台回「平台的 GitHub 憑證有問題」 | `GITHUB_TOKEN` 過期或權限不足。要給相關 repo 的 Actions 讀寫；若要同步 `stores.json`，還要 Contents 讀寫 |
| 在平台改了店別但執行時沒生效 | 設定頁存檔會把 `stores.json` 寫回 repo，確認那個 commit 真的進去了；workflow 讀的是 `PAYOUT_GITHUB_REF`（預設 main）那一版 |

## 已知但還沒處理

**`EMPTY_REPORT` 會讓整次執行標記失敗。** 某家店該期間真的沒有出金時，CYBERBIZ
照樣匯出一張只有表頭的檔案，driver 判定為 `EMPTY_REPORT`。目前這算失敗，所以
9 家跑完 8 家也會看到一個大紅叉——2026-08-19 那次就是這樣（台南新光西門）。

比較合理的作法是當成「跳過」：不算失敗，但在報告的「待人工處理」列出來提醒確認——
店名改過或區間選錯也會長成一模一樣的空報表，靜靜跳過正是真問題被漏掉的方式。
改法寫在帳務 repo 已關閉的 PR #5，要做的話可以照抄。
