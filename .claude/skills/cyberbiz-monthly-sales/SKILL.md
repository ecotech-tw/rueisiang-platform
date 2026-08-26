---
name: cyberbiz-monthly-sales
description: "維護與執行 CYBERBIZ 商品銷售總表：匯出、取回 XLSX、解析月彙總、上傳 Google Drive、保存 NAS、建立 D1 manifest 與排查小香查詢所需資料。"
---

# CYBERBIZ 商品銷售總表

這份 skill 是商品銷售報表的操作與維護知識。它和 `cyberbiz_query_sales_report` 不同：

- MCP/tool 負責讓小香查詢已發布的資料。
- 這份 skill 負責人員或維護者執行匯出、解析、publish、驗證與排錯。
- 真正的執行程式在 `tools/cyberbiz-monthly-payout/sales-driver.mjs`；解析與公司彙總程式在 `tools/cyberbiz-monthly-sales/`。

查詢契約與 NAS、D1、Google Drive 的責任邊界，以 `docs/cyberbiz-report-query.md` 為準。若本 skill 和程式行為不一致，先修正文檔或程式，不要靠口頭約定繼續操作。

## 先理解資料邊界

商品銷售總表是月彙總，不是逐日明細。即使匯出時選了 `2026-07-14` 到 `2026-07-18`，檔案裡的銷售數仍不能精確拆成這五天各自的數字。

| 執行區間 | 會做什麼 | 可否建立 AI manifest |
|---|---|---|
| 完整月份 | 每個選定櫃位匯出、取回、驗證、上傳 Drive；解析成 normalized JSON 上傳 NAS；寫入 store manifest | 可以 |
| 完整月份且選全部櫃位 | 除了各店 manifest，再把各店依 SKU 合併成公司 aggregate，寫入 `scopeId=company` manifest | 可以 |
| 自訂日期區間 | 匯出並把原始 XLSX 上傳各店 Drive，供同仁自行對帳 | 不可以 |

自訂區間不要把資料拆成每天，也不要為了讓查詢通過而建立假 manifest。查詢工具應回傳 `UNSUPPORTED_GRANULARITY`，並提示到 `/tools/cyberbiz-sales` 補跑完整月份。沒有 manifest 或資料仍未發布時，應回傳 `NO_DATA_FOR_RANGE` 或 `INCOMPLETE_COVERAGE` 及後台執行提示。

## 執行入口

正式工作由 GitHub Actions 執行，平台後台只負責權限檢查、留下 run audit、觸發 workflow 與顯示狀態。不要在 Worker 裡開 Chrome、登入 CYBERBIZ 或讀 Google 憑證。

### 後台與 workflow

- 後台頁面：`/tools/cyberbiz-sales`
- API：`/api/tools/cyberbiz-sales/run` 與 `/api/tools/cyberbiz-sales/state`
- workflow：`.github/workflows/cyberbiz-sales-report.yml`
- runner：`tools/cyberbiz-monthly-payout/sales-driver.mjs`
- payout 與 sales 共用 CYBERBIZ 帳號、Chrome profile 與 concurrency group；兩者不可並行操作。
- 執行權限是 `tools:cyberbiz-sales:run`；查詢權限是 `reports:cyberbiz:read`。不要把執行權限混給只有查詢需求的人員。

### 本機診斷

```bash
cd tools/cyberbiz-monthly-payout
npm ci
node sales-driver.mjs --help
node sales-driver.mjs --month 2026-07 --store 宏匯廣場1F
node sales-driver.mjs --start 2026-07-14 --end 2026-07-18 --store 宏匯廣場1F
node sales-driver.mjs --list-stores
```

規則如下：

- 不帶日期時，使用 `Asia/Taipei` 的上個月。
- `--month` 與 `--start/--end` 只能擇一；自訂區間的 `--start` 與 `--end` 必須同時提供，且為含首尾日期。
- `--store` 可以重複提供；省略時使用設定檔中的所有店別。
- `--headless` 給 CI 使用。
- `--skip-upload` 不會產生 Drive 檔案；完整月份不要使用它，因為 store manifest 必須有 Drive metadata。
- `--list-stores` 是核對 CYBERBIZ 後台店名的診斷命令，不會建立 manifest。

手動從 XLSX 做 parser 診斷時：

```bash
cd tools/cyberbiz-monthly-sales
node parse.mjs <sales.xlsx> <scope-id> <scope-name>
npm test
```

正式月結不要只跑 `parse.mjs`；它不會上傳 NAS、更新 D1，也不會產生公司 aggregate。

## 憑證與設定

`tools/cyberbiz-monthly-payout/config.json` 保存非機密設定，例如：

- `cyberbizOrigin`
- `salesReportPath`
- `recipientEmail`
- 每個店別的 `name`、`driveFolderUrl` 與 `driveFolderName`
- `stagingDir`、`reportsDir`、附件寄件者與 2FA 搜尋規則

店名必須和 CYBERBIZ 後台完全一致；Drive folder URL 要指向該櫃位資料夾。平台設定頁更新店別後，必須確認 shared `stores.json` 同步到 sales workflow 實際 checkout 的 repository/ref。

GitHub Actions secrets 依執行模式分為：

- 登入與取檔：`CYBERBIZ_USERNAME`、`CYBERBIZ_PASSWORD`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GMAIL_REFRESH_TOKEN`
- 上傳 Drive：`GOOGLE_REFRESH_TOKEN`
- 完整月份 publish：`NAS_STORAGE_URL`、`NAS_STORAGE_TOKEN`、`PLATFORM_API_URL`、`CYBERBIZ_REPORT_INGEST_TOKEN`

完整月份的必要 secrets 必須在開啟瀏覽器、匯出或上傳前完成 preflight。不要把密碼、refresh token、Chrome profile、XLSX 或 normalized JSON commit 到 git；本機產物應留在 `.gitignore` 指定的 `staging/`、`reports/`、`screenshots/` 與 `chrome-profile/`。

實際匯出／Gmail 附件取得的瀏覽器與 connector 操作，沿用 CYBERBIZ POS report export 的操作規範；不要用 raw CDP、cookies 或替代下載方式繞過登入流程。

## 報表解析規則

`tools/cyberbiz-monthly-sales/lib/sales.mjs` 的 `parseSalesReport()` 會：

1. 讀取第一張工作表的日期區間，確認檔案沒有跨月份，並驗證與要求月份一致。
2. 從第 2 列辨識必要欄位：`SKU`、`商品名稱`、`銷售數量`、`退回數量`、`淨銷售數量`、`售額總計`。
3. 讀取 `類別`、`產品廠商編號`、`售價`、`成本總計`、`毛利總計`、`毛利率` 等可選欄位。
4. 找到 `總計` 列，排除明細以外的列，並驗證明細加總與報表總計一致。
5. 將文件標記為 `kind=cyberbiz_sales_monthly`、`granularity=month`。

金額一律使用報表的 `售額總計`，不要用售價乘數量重算；折扣、組合商品、贈品可能使兩者不同。查詢使用的數量欄位要分清楚：

- `grossQuantity`：銷售數量
- `returnQuantity`：退回數量
- `netQuantity`：淨銷售數量
- `salesAmount`：售額總計

商品分類來自 `類別` 欄。查詢時 `sku` 是不分大小寫的精確比對，`category` 是不分大小寫的精確比對，`productName` 是不分大小寫的包含比對；不要把分類查詢誤當成模糊關鍵字查詢。

normalized document 的主要結構如下：

```json
{
  "schemaVersion": 1,
  "kind": "cyberbiz_sales_monthly",
  "scopeType": "store",
  "scopeId": "store-...",
  "reportMonth": "2026-07",
  "coverageStart": "2026-07-01",
  "coverageEnd": "2026-07-31",
  "granularity": "month",
  "rows": [],
  "totals": {
    "grossQuantity": 0,
    "returnQuantity": 0,
    "netQuantity": 0,
    "salesAmount": 0
  }
}
```

## 公司 aggregate

`tools/cyberbiz-monthly-sales/lib/aggregate.mjs` 的 `aggregateSalesDocuments()` 在 runner 上先執行，讓公司查詢維持一次 D1 lookup 加一次 NAS GET：

- 以 SKU 作為跨櫃位合併鍵。
- 同一 SKU 的商品名稱或分類不同時，停止 publish；不要靜默選一個值。
- `grossQuantity`、`returnQuantity`、`netQuantity`、`salesAmount` 逐店加總。
- 公司文件使用 `scopeType=company`、`scopeId=company`，仍然是 `granularity=month`。
- 公司 aggregate 不需要 Drive 檔案；各店原始 XLSX 仍要留在各自 Drive 資料夾。

查詢公司整體或單一櫃位時，小香只需要呼叫一次 `cyberbiz_query_sales_report`。不要為公司查詢逐店呼叫 tool，也不要把五萬筆訂單或整本 XLSX 塞進 D1。

## Publish 與儲存責任

完整月份每一個 store 的順序是：

1. 從 CYBERBIZ 匯出商品銷售總表。
2. Gmail 只取本次匯出之後、寄件者和檔名都符合的最新 XLSX。
3. 驗證月份、必要欄位、總計，並把原始 XLSX 上傳該店 Google Drive。
4. 產生 normalized sales JSON，上傳 NAS `reports/cyberbiz/<scopeId>/<YYYY>/<MM>/` 下的物件。
5. 呼叫 `POST /api/internal/cyberbiz-reports/publish`，先寫 `staged`，確認物件存在後才寫 `published`。

公司 aggregate 的 normalized JSON 也上傳 NAS，再寫 `scopeId=company` 的 sales manifest。D1 只存索引與 metadata，不存 XLSX 內容或完整商品 rows。原始 XLSX 與 normalized JSON 的角色、checksum、parser version 必須屬於同一個 report version；重跑新版本時不得沿用舊版本的 Drive artifact。

出金表與商品銷售表在 D1 用 `reportKind` 分開索引。只有需要人工交付「同一份 Excel、不同 tab」時，才使用既有 bundle 流程把商品銷售分頁加到出金 XLSX；不要因此把 sales 與 payout 的 AI 查詢資料混在同一份 JSON。

## 查詢結果與處理方式

MCP、Sandbox、LINE 共用 `cyberbiz_query_sales_report`，必要參數是：

- `period`: `YYYY-MM`
- `scopeType`: `company` 或 `store`
- `scopeId`: `scopeType=store` 時的固定櫃位 ID

可選篩選是 `sku`、`category`、`productName`。`startDate` 與 `endDate` 只有在完整月份時才能使用；任何非完整月份的商品銷售日期區間都不能回答精確數字。

遇到下列狀態時，不要自行估算或把空結果說成零：

- `NO_DATA_FOR_RANGE`：沒有已發布的指定月份／scope manifest。
- `INCOMPLETE_COVERAGE`：manifest 覆蓋範圍不足。
- `UNSUPPORTED_GRANULARITY`：要求日或任意日期區間，但 sales document 只有月粒度。
- `report_manifest_mismatch` 或 invalid normalized JSON：停止回傳數字，修復 NAS／manifest 對應關係後再查。

上述查詢失敗狀態應保留結構化 `nextStep.type=open_backend_report_runner`，並指向 `/tools/cyberbiz-sales`；這只是引導有執行權限的人員補跑，不代表查詢者自動取得執行權限。

## 產物與人工對帳

- Drive：保存同仁要開啟、下載、對帳的原始銷售 XLSX；店別資料夾沿用出金表的 Drive 結構。
- NAS：保存原始 XLSX 與 normalized JSON，供 API 查詢與版本追蹤。
- D1：保存 store/company manifest 與後台 run audit，不保存整本報表。
- GitHub Actions artifact／summary：保存該次執行的診斷結果與報告，不當成長期查詢資料來源。

若要人工看完整月的出金與銷售資料，確認兩份原始 XLSX 都已上傳；若要交付合併版 Excel，使用 bundle 產物並確認 sales tab 存在，不要刪除或重建出金表原有公式與人工填寫欄位。

## 排錯順序

1. 先確認執行區間：完整月份才期待 manifest；自訂區間只有 Drive 檔案是正常結果。
2. 確認 `config.json` 店名、`salesReportPath`、Drive folder URL，以及 workflow checkout 的 `stores.json` 版本。
3. 確認 GitHub Actions preflight 是否在瀏覽器啟動前通過，尤其是完整月份的 NAS、平台 API 與 ingest token。
4. 確認 Gmail 附件是本次 `submittedAt` 之後、檔名精確符合 `[店名]商品銷售總表YYYY-MM-DD~YYYY-MM-DD.xlsx` 的 XLSX。
5. 看到 `RANGE_MISMATCH`、缺欄位、總計不一致時，保留原始 XLSX 與 screenshot，修正資料來源或 parser，不要強制 publish。
6. 看到公司 aggregate 的 SKU 名稱／分類不一致時，先確認 CYBERBIZ 各店商品主檔；不要把衝突資料合併成一筆。
7. D1 查不到資料時，依序查 manifest 的 `reportKind`、`scopeType`、`scopeId`、`status`、`sourceChecksum`，再確認 NAS object key 與 normalized document 的月份／scope 完全一致。
8. 重跑前先確認同一個 workflow 是否仍在 concurrency queue；不要同時重開相同 Chrome profile。

常見錯誤包括：

- `REPORT_PAGE_MISSING`：確認 CYBERBIZ 版本或 `salesReportPath`。
- `FILTER_MISMATCH`：日期、收件人或報表頁面的條件被後台改寫。
- `STORE_NOT_FOUND`：設定檔店名和後台店名不完全一致。
- `RANGE_MISMATCH`：附件月份或日期不是本次要求。
- `EMPTY_REPORT`：先確認該店是否真的沒有商品明細，再決定是否補跑；不要把空表當作成功的零銷售資料。
- `GMAIL_FORBIDDEN`、`GOOGLE_API_ERROR`、`invalid_grant`：檢查 Gmail／Drive OAuth scopes、refresh token 與 Google app 發布狀態。
- `nas_not_configured`：完整月份查詢或 publish 所需 NAS 設定尚未完成。

## 修改前後的驗證

修改 parser、aggregate、runner 或本 skill 對應的流程時，至少執行：

```bash
cd tools/cyberbiz-monthly-sales
npm test

cd ../cyberbiz-monthly-payout
npm test
```

若修改了平台 query、tool、manifest、權限或 API：

```bash
cd apps/api
pnpm test -- --reporter=dot

cd ../..
pnpm typecheck
pnpm build
```

最後檢查 `git diff --check`，確認沒有 secrets、XLSX、Chrome profile、staging 產物或未解決的 conflict marker。實際匯出測試需要有效的 CYBERBIZ、Gmail、Drive 與 NAS credentials；沒有 credentials 時，只執行 parser／aggregate／runner selftest，不要假裝已驗證外部服務。
