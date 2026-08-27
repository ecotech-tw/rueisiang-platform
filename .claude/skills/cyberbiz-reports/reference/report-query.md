# CYBERBIZ 報表查詢

報表查詢採「Google Drive 留原始檔、D1 留每日查詢資料」：

- Google Drive：保留每個據點的原始 XLSX，出金表仍可包含人工對帳欄位。
- D1：只保存三張查詢表：`report_scopes`、`report_sales_daily`、`report_payout_daily`。
- NAS：不是報表查詢的必要條件；NAS 只供平台其他媒體功能使用。

## 查詢入口

登入後的 HTTP API：

```text
GET /api/reports/cyberbiz/sales?period=2026-07&scopeType=store&scopeName=誠品西門店3F
GET /api/reports/cyberbiz/sales?period=2026&scopeType=company&category=沐浴
GET /api/reports/cyberbiz/payout?startDate=2026-07-01&endDate=2026-07-31&scopeType=company
```

`period` 支援 `YYYY` 與 `YYYY-MM`。自訂區間改用同時存在的
`startDate=YYYY-MM-DD`、`endDate=YYYY-MM-DD`。查詢單一據點時，使用者只要提供
`scopeName`；服務端會用 `report_scopes.normalized_name` 對應固定 `scopeId`，因此名稱中
是否有空白不影響查詢。

商品銷售可再傳：

- `sku`：精確查詢 SKU。
- `category`：查詢分類／標籤。
- `productName`：商品名稱關鍵字。
- `groupBy=day,month,scope,sku,category`：指定回傳列的分組方式。

出金可用 `groupBy=day,month,scope`。出金不保存也不接受支付方式、POS、操作人員篩選。

## D1 三張表

### `report_scopes`

保存 AI 與 API 用來辨識據點的名稱：

| id | scope_kind | name | normalized_name | active |
| --- | --- | --- | --- | --- |
| `cyberbiz:store:...` | `store` | 誠品西門店 3F | 誠品西門店3f | 1 |
| `company` | `company` | 公司整體 | 公司整體 | 1 |

查詢以 `id` 作為事實表的 scope key；目前 CYBERBIZ 的 ID 由穩定的店名產生，未來
蝦皮也直接使用自己的通路前綴。名稱不唯一時不猜測，查詢會視為找不到，避免把資料算到錯的據點。

### `report_sales_daily`

主鍵是 `(scope_id, business_date, sku)`：

| scope_id | business_date | sku | product_name | category | gross_quantity | return_quantity | net_quantity | sales_amount |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `cyberbiz:store:...` | 2026-07-01 | `SKU-001` | 商品一 | 沐浴 | 3 | 1 | 2 | 180 |

金額直接採商品銷售報表的「售額總計」，不以售價乘數量重算，以保留折扣、組合商品、
紅利與贈品的原始口徑。

### `report_payout_daily`

主鍵是 `(scope_id, business_date)`：

| scope_id | business_date | payout_amount |
| --- | --- | ---: |
| `cyberbiz:store:...` | 2026-07-01 | 2040 |

同一天出金表中的多筆資料在匯入時加總，故不保存 `income_type`、POS 或操作人員。

## 匯入流程

後台有兩個執行入口，但共用登入、Gmail 2FA、店別解析與 Drive 設定：

1. `出金表執行`：匯出指定區間、驗證 XLSX、補上人工對帳欄位、上傳 Drive；再把各列按日
   加總後寫入 `report_payout_daily`。
2. `商品銷售報表執行`：先上傳指定區間的原始 XLSX 到 Drive；完整月份為取得每日粒度，
   會再對每一天各匯出一次並解析，再寫入 `report_sales_daily`。

只有完整月份才匯入 D1。自訂區間仍可供同仁在 Google Drive 查帳，但不會把區間報表
誤當成完整的每日資料。runner 呼叫內部匯入 API 時使用獨立的
`CYBERBIZ_REPORT_INGEST_TOKEN`；token 不會進入 AI tool 結果。

## 聚合規則

不建立月、年或公司 aggregate 檔案，也不建立月／年 manifest。公司查詢會在 D1 直接把
所有 `active=1` 的 store scope 聚合；月份與年份只是日期條件：

```sql
SELECT substr(business_date, 1, 7) AS report_month,
       SUM(net_quantity) AS net_quantity,
       SUM(sales_amount) AS sales_amount
FROM report_sales_daily
WHERE business_date BETWEEN '2026-01-01' AND '2026-12-31'
GROUP BY substr(business_date, 1, 7);
```

因此一次 `query_sales_report` 或 `query_payout_report` 就能完成單據點、分類、商品、
月份、年份與公司整體查詢，不需要模型逐店呼叫工具。

## AI tools

小香使用兩個 read-only tool：

- `query_sales_report`：商品數量、銷售額、SKU、分類、據點與公司聚合。
- `query_payout_report`：據點與公司每日／月份／年份出金聚合。

兩個 tool 都要求 `reports:cyberbiz:read`。沒有資料時回傳
`status=NO_DATA_FOR_RANGE` 與 `nextStep.type=open_backend_report_runner`，指向有權限的
後台執行頁；小香應提示同仁補跑，不應改用 `crm_get_orders` 猜測報表結果。

MCP endpoint 是 `POST /api/mcp/cyberbiz-reports`，使用獨立的
`CYBERBIZ_REPORT_MCP_TOKEN` bearer token，並重用相同的兩個 tool 與 D1 查詢服務。

## 設計邊界（不要做的事）

這幾條是動工前定下來的，實作完了仍然成立：

- **不做即時 CYBERBIZ API 查詢。** 查詢只讀已匯入 D1 的資料，避免每個問題都打官網而變慢、被限流，或取得尚未對帳的數字。
- **Worker 的 request 路徑不解析 XLSX。** XLSX 在 runner 上解析，Worker 只接收已整理的每日資料。
- **不接外部 MCP client。** 這個 adapter 只服務平台自己的助理 surface。
- **MCP surface 裡不做儀表板或試算表編輯器。** 它只回結構化查詢結果。
- **商品銷售資料以每日粒度保存。** 只有完整月份逐日匯入後，才能安全回答任意日期區間；自訂區間本身不會被誤當成完整資料。

模型負責的只有「把自然語句轉成固定查詢參數」與「把 `NO_DATA_FOR_RANGE`、
`INCOMPLETE_COVERAGE` 翻成人話」。精確加總由 D1 與 DB aggregation 提供；模型不直接讀
Google Drive 或任何外部 MCP。NAS token 與 ingest token 永遠不會進入模型 context。
