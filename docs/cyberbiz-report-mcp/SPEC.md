# CYBERBIZ Report Query MCP

## Value Proposition

讓小香用自然語句查詢已完成對帳的 CYBERBIZ 銷售與出金資料，而不需要知道 Google Drive 檔名、NAS 路徑或逐櫃位查詢流程。

Target user 是需要快速回答「某商品／分類／櫃位／公司整體在某月份賣了多少、營收多少」的內部同仁。

**Core actions**: 查詢商品銷售、查詢分類銷售、查詢出金區間。

## Why LLM?

**Conversational win**: 「宏匯一樓三月沐浴類賣幾件、營收多少」可以由小香抽取月份、scope、分類與指標，不需要同仁先選報表、檔案與篩選欄位。

**LLM adds**: 將自然語句轉成固定查詢參數，並把 `NO_DATA_FOR_RANGE`、`INCOMPLETE_COVERAGE`、`UNSUPPORTED_GRANULARITY` 說成人能理解的答案。

**What LLM lacks**: 原始資料與精確加總由平台的 D1 manifest、NAS normalized JSON 與 DB aggregation 提供；模型不能直接讀 NAS、Google Drive 或任意外部 MCP。

## UI Overview

這個 vertical slice 不新增 MCP app UI。小香看見 tool 的結構化結果後，直接以短答案回覆；若資料不可回答，必須保留狀態與涵蓋日期，不得猜測或用月報拆日。

## Product Context

- Existing platform: one Cloudflare Worker + D1, shared `ToolContract`, LINE and Sandbox assistant surfaces.
- Data sources: monthly CYBERBIZ 商品銷售總表與每日出金表；原始 XLSX、normalized JSON 與 combined XLSX 存 NAS，D1 只存 manifest。
- Company scope: runner 預先以 SKU 合併各櫃位 sales JSON、保留 payout rows 後產生 `scopeId=company` aggregate，查詢時只需要一份 JSON。
- Auth: internal assistant uses existing permission `reports:cyberbiz:read`; external MCP requests must use a separate authenticated transport and may not bypass that permission.
- Constraints: sales report granularity is month only; arbitrary daily sales ranges are rejected. `staged` manifests are never queryable. NAS token and ingest token are never exposed to the model.

## Tool Contract

- `cyberbiz_query_sales_report`: one call accepts period, company/store scope, SKU, category, product name, and optional date range.
- `cyberbiz_query_payout_report`: one call accepts period, company/store scope, date range, income type, POS, and operator.
- The MCP adapter reuses the same tool definitions and service bridge as Sandbox/LINE; it must not duplicate aggregation logic.

## UX Flows

Sales query:

1. The assistant calls `cyberbiz_query_sales_report` with one month and one scope.
2. The server returns filtered rows, totals, manifest coverage, or an explicit non-answer status.
3. The assistant summarizes quantity and sales amount without inventing daily detail.

Payout query:

1. The assistant calls `cyberbiz_query_payout_report` with one month, one scope, and an inclusive date range.
2. The server returns the daily rows and aggregate amount after coverage validation.
3. The assistant summarizes the amount and can mention the selected payment/POS/operator filters.

## MCP Transport

- Endpoint: `POST /api/mcp/cyberbiz-reports` using JSON-RPC over Streamable HTTP.
- The endpoint returns `405` for GET/DELETE because this read-only adapter does not open an SSE server stream; POST responses are single JSON objects.
- Supported methods: `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- Authentication: dedicated `CYBERBIZ_REPORT_MCP_TOKEN` bearer token; it is separate from the NAS token and ingest token.
- The adapter exposes only the two CYBERBIZ report tools, checks `mcp` surface and `reports:cyberbiz:read`, and returns structured JSON without NAS keys or credentials.
- Unsupported methods, unknown tools, malformed arguments, and missing authorization are explicit JSON-RPC errors.

## Non-goals

- No live CYBERBIZ API query per user question.
- No direct XLSX parsing in the Worker request path.
- No external MCP client integration.
- No dashboard or workbook editor inside the MCP surface.
