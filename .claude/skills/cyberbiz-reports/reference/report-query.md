# CYBERBIZ 報表查詢

報表查詢採「Google Drive 保留原始檔、D1 保留查詢資料」：

- Google Drive：保留各據點的原始 XLSX，出金表仍可包含人工對帳欄位。
- D1：查詢使用 `report_scopes`、`report_sales_monthly`、`report_payout_daily` 三張表。
- NAS：不是報表查詢的必要條件。

## 查詢入口

登入後的 HTTP API：

```text
GET /api/reports/cyberbiz/sales?period=2026-07&scopeType=store&scopeName=誠品西門店3F
GET /api/reports/cyberbiz/sales?period=2026&scopeType=company&category=沐浴
GET /api/reports/cyberbiz/payout?startDate=2026-07-01&endDate=2026-07-31&scopeType=company
```

`period` 支援 `YYYY` 與 `YYYY-MM`。自訂日期區間可改用同時存在的
`startDate=YYYY-MM-DD`、`endDate=YYYY-MM-DD`；商品銷售的自訂區間必須涵蓋完整月份，部分月份會回傳
`UNSUPPORTED_GRANULARITY`。查詢單一據點時使用者只要提供 `scopeName`，服務端會以
`report_scopes.normalized_name` 對應固定 `scopeId`。

商品銷售可再傳：

- `sku`：精確查詢 SKU。
- `category`：查詢分類／標籤。
- `productName`：商品名稱關鍵字。
- `groupBy=month,scope,sku,category`：指定回傳列的分組方式；不提供時預設依 SKU。

出金可用 `groupBy=day,month,scope`。出金不保存也不接受付款方式、POS 或操作人員篩選。

## D1 三張表

### `report_scopes`

保存 AI 與 API 用來辨識據點的名稱：

| id | scope_kind | name | normalized_name | active |
| --- | --- | --- | --- | ---: |
| `cyberbiz:store:...` | `store` | 誠品西門店 3F | 誠品西門店3f | 1 |
| `company` | `company` | 公司整體 | 公司整體 | 1 |

### `report_sales_monthly`

主鍵是 `(scope_id, report_month, sku)`；每個據點每個月份每個 SKU 一筆：

| scope_id | report_month | sku | product_name | category | gross_quantity | return_quantity | net_quantity | sales_amount |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| `cyberbiz:store:...` | 2026-07 | `SKU-001` | 商品一 | 沐浴 | 3 | 1 | 2 | 180 |

金額直接採商品銷售報表的「售額總計」，不以售價乘數量重算，以保留折扣、組合商品、紅利與贈品的原始口徑。

### `report_payout_daily`

主鍵是 `(scope_id, business_date)`：

| scope_id | business_date | payout_amount |
| --- | --- | ---: |
| `cyberbiz:store:...` | 2026-07-01 | 2040 |

同一天出金表中的多筆資料在匯入時加總，因此不保存 `income_type`、POS 或操作人員。

## 匯入流程

1. `出金表執行`：匯出指定區間、驗證 XLSX、補上人工對帳欄位、上傳 Drive；再把各列按日期加總後寫入
   `report_payout_daily`。
2. `商品銷售報表執行`：匯出一份完整月份的原始 XLSX、上傳 Drive，再把該份報表整理後寫入
   `report_sales_monthly`。一個月份只有一次匯入，不再拆成每日匯出，也不再傳 `coveredDates`。

商品銷售匯入 payload 的每筆列改用 `reportMonth`，不再使用 `businessDate`；零筆月份用頂層的
`reportMonth` 指定要清除的月份。同一店同一月重匯時，會先清除該月資料，再寫入這次報表的 SKU。

只有完整月份才匯入 D1。自訂區間仍可上傳原始 XLSX 到 Google Drive，但不會匯入 D1，也不能當成月資料查詢。

## 聚合規則

不建立月、年或公司 aggregate 檔案。公司查詢會在 D1 直接聚合所有 `active=1` 且屬於 CYBERBIZ 的 store scope；
月份與年份只是 `report_month` 的範圍條件：

```sql
SELECT report_month,
       SUM(net_quantity) AS net_quantity,
       SUM(sales_amount) AS sales_amount
FROM report_sales_monthly
WHERE report_month BETWEEN '2026-01' AND '2026-12'
GROUP BY report_month;
```

因此一次 `query_sales_report` 或 `query_payout_report` 就能完成據點、分類、商品、月份、年份與公司整體查詢。

## AI tools

- `query_sales_report`：商品數量、銷售額、SKU、分類、據點與公司聚合；銷售分組不支援 `day`。
- `query_payout_report`：據點與公司每日／月份／年份出金聚合。

兩個 tool 都要求 `reports:cyberbiz:read`。沒有資料時回傳 `status=NO_DATA_FOR_RANGE` 與
`nextStep.type=open_backend_report_runner`；不支援部分月份時回傳 `UNSUPPORTED_GRANULARITY`。

MCP endpoint 是 `POST /api/mcp/cyberbiz-reports`，使用獨立的 `CYBERBIZ_REPORT_MCP_TOKEN` bearer token，
重用相同的兩個 tool 與 D1 查詢服務。
