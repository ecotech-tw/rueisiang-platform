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

## 執行與 manifest 規則

後台目前分成兩個執行入口：`/tools/payout` 執行每日出金表，
`/tools/cyberbiz-sales` 執行商品銷售總表。兩者使用相同的 Google Drive 店別資料夾，
但 workflow 與 D1 run 記錄分開，避免其中一種報表失敗時阻塞另一種報表。

日期區間會先由後台判斷：

- **完整月份**：runner 解析報表、把原始 XLSX 與 normalized JSON 保存到 NAS，並在 D1 建立該報表種類的 store manifest。
  所有店別都成功時，再以 `scopeId=company` 寫入預先彙總的公司 manifest；小香查詢公司資料只需一次 tool call。
- **自訂區間**：runner 只把原始 XLSX 上傳到該店別的 Google Drive，方便同仁自行對帳；不解析成 NAS JSON，也不建立 AI manifest。
  這是因為商品銷售總表是月彙總，不能從月報精確拆成每日或任意日期資料。

出金表與商品銷售表在 D1 以 `reportKind` 分開索引（`payout`、`sales`），
共用月份、店別／公司 scope 與 source version，不需要把兩種查詢資料硬塞進同一份 JSON。
Google Drive 的原始檔目前維持兩份獨立 XLSX；既有 `publish-report.mjs --kind bundle` 仍可在需要人工交付時，
以出金表為 base 增加商品銷售分頁，但不影響兩個後台入口獨立執行。

當 AI tool 找不到完整月份資料、資料仍在 staged，或使用者要求商品銷售的非月粒度時，
會回傳結構化 `nextStep.type=open_backend_report_runner`，並指向對應的後台執行頁，
提醒有權限的公司人員補跑報表。執行頁與狀態 API 都要求 `tools:cyberbiz-payout:run` 或
`tools:cyberbiz-sales:run`，一般查詢權限不會因此取得報表執行權限。

MCP endpoint 是 `POST /api/mcp/cyberbiz-reports`，使用獨立 `CYBERBIZ_REPORT_MCP_TOKEN` bearer token；它只暴露兩個報表 tool，並重用既有 tool executor 與查詢服務。瀏覽器 Origin、Content-Type、Accept 與 MCP protocol header 都會先驗證，工具執行結果會保留結構化狀態，不會把 NAS key 或 credential 傳給模型；GET/DELETE 會回 405，因為此 adapter 不開啟 server-side SSE stream。

## 月批次 publish contract

`tools/cyberbiz-monthly-payout/lib/report-publish.mjs` 提供 runner-side publish helper。它會把相關的原始 XLSX、normalized JSON，
以及需要時的 combined XLSX 上傳到 NAS 的 `reports/cyberbiz/...`，再呼叫：

```text
POST /api/internal/cyberbiz-reports/publish
Header: x-cyberbiz-report-token: <CYBERBIZ_REPORT_INGEST_TOKEN>
```

流程固定是：

1. NAS 物件全部存在後寫入 `staged` manifest。
2. 需要人工對帳的原始 XLSX 上傳 Google Drive；bundle 才會額外完成出金表公式驗證。
3. 再寫入同一個 `sourceChecksum` 的 `published` manifest。

NAS upload 可帶 checksum/角色衍生的 `objectId`。同一批次重跑會得到同一個 object key；相同內容回 HTTP 200，不同內容則回 HTTP 409，不會靜默覆寫。API publish 只用 HEAD 檢查物件存在與 MIME，不把 XLSX 內容讀進 Worker。

`sales` manifest 需要 sales JSON，`payout` manifest 需要 payout JSON；store manifest 另外需要對應的 Drive file id/url，
company aggregate 不需要 Drive 檔案。`bundle` 才同時需要兩種 JSON、combined XLSX 與 Drive metadata。
只有 `staged` 時，查詢 API 不會選用該版本。

公司 scope 的 sales JSON 由 runner 以 SKU 合併各櫃位 sales document；同 SKU 的商品名稱或分類不一致時會中止 publish。
公司 scope 的 payout JSON 則保留各店別的每日出金 rows。combined XLSX 以既有出金 XLSX 為 base 新增商品銷售分頁，
原有出金欄位與公式不重新產生。
