# CYBERBIZ 報表查詢

這個功能把「原始檔案」與「查詢資料」分開：

- NAS 保存原始 XLSX 與 normalized JSON。報表物件使用 `reports/cyberbiz/<scopeId>/<YYYY>/<MM>/`，目前接受 `.xlsx` 與 `.json`。
- D1 只保存 `cyberbiz_report_manifests`，記錄月份、scope、涵蓋日期、parser 版本、checksum、NAS key 與 Drive 連結。
- 公司整體使用 `scopeId=company` 的預先彙總 JSON；查詢時不需要逐櫃位呼叫工具。

## 查詢入口

HTTP API：

```text
GET /api/reports/cyberbiz/sales
  ?period=2026-07
  &scopeType=company
  &category=沐浴
```

每日出金使用同一個 scope 與 manifest：`GET /api/reports/cyberbiz/payout?period=2026-07&scopeType=company&startDate=2026-07-01&endDate=2026-07-31`。小香對應的 tool 是 `cyberbiz_query_payout_report`。

單一櫃位將 `scopeType=store&scopeId=<固定櫃位 ID>`。也可以提供 `sku` 或 `productName`。小香使用同一個 `cyberbiz_query_sales_report` tool；一次 tool call 由 Worker 內部完成 manifest lookup、NAS JSON 讀取與彙總。

商品銷售總表的粒度是月，不是假裝成逐日資料。因此：

- 完整月份有 manifest 且 coverage 完整時，回傳 `status=ok`。
- 沒有對應資料時，回傳 `NO_DATA_FOR_RANGE`。
- 只要求月份中一段日期時，回傳 `UNSUPPORTED_GRANULARITY`。
- manifest 宣告的涵蓋日不足時，回傳 `INCOMPLETE_COVERAGE`。

查詢金額採用報表的「售額總計」欄，不用售價乘以數量重算，避免折扣、組合商品與贈品造成誤差。

## 目前已完成與下一階段

目前已完成 NAS reports namespace、D1 manifest、商品銷售總表 parser、查詢 API、一次呼叫 tool contract、權限 migration、monthly publish helper 與 read-only MCP transport。月批次仍由 GitHub Actions runner 執行；NAS server 上線後再接正式環境：

1. 將 `publish-report.mjs` 接到正式月批次，並確認 CYBERBIZ 商品銷售總表的實際匯出頁面與欄位 selector。
2. 對各櫃位產生 normalized JSON；公司整體則先用 SKU 合併 sales、保留所有 payout rows，再 publish `scopeId=company` 的 aggregate JSON。
3. 讓 combined XLSX 上傳 Google Drive，同一版本再保存到 NAS；Drive 完成且公式驗證通過後，才把 manifest 從 staged 切成 published。

MCP endpoint 是 `POST /api/mcp/cyberbiz-reports`，使用獨立 `CYBERBIZ_REPORT_MCP_TOKEN` bearer token；它只暴露兩個報表 tool，並重用既有 tool executor 與查詢服務。瀏覽器 Origin、Content-Type、Accept 與 MCP protocol header 都會先驗證，工具執行結果會保留結構化狀態，不會把 NAS key 或 credential 傳給模型；GET/DELETE 會回 405，因為此 adapter 不開啟 server-side SSE stream。

## 月批次 publish contract

`tools/cyberbiz-monthly-payout/lib/report-publish.mjs` 提供 runner-side publish helper。它會把原始 sales/payout XLSX、normalized sales/payout JSON、combined XLSX 上傳到 NAS 的 `reports/cyberbiz/...`，再呼叫：

```text
POST /api/internal/cyberbiz-reports/publish
Header: x-cyberbiz-report-token: <CYBERBIZ_REPORT_INGEST_TOKEN>
```

流程固定是：

1. NAS 物件全部存在後寫入 `staged` manifest。
2. Drive XLSX 上傳並完成既有公式驗證。
3. 再寫入同一個 `sourceChecksum` 的 `published` manifest。

NAS upload 可帶 checksum/角色衍生的 `objectId`。同一批次重跑會得到同一個 object key；相同內容回 HTTP 200，不同內容則回 HTTP 409，不會靜默覆寫。API publish 只用 HEAD 檢查物件存在與 MIME，不把 XLSX 內容讀進 Worker。

`published` 需要 sales JSON、payout JSON、combined XLSX 及 Drive file id/url；只有 `staged` 時，查詢 API 不會選用該版本。現有 payout runner 尚未直接匯出商品銷售總表，因此在 NAS server 上線前先保留這個可測試的 publish 邊界；待確認 CYBERBIZ 商品銷售總表頁面的實際匯出流程後，再接入同一個 driver。

公司 scope 的 JSON 由 runner 以 SKU 合併各櫃位 sales document、保留每筆 payout row 後產生；同 SKU 的商品名稱或分類不一致時會中止 publish。combined XLSX 則以既有出金 XLSX 為 base 新增商品銷售分頁，原有出金欄位與公式不重新產生。
