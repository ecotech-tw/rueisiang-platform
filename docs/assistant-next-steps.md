# 小香下一階段任務

## 優先順序

### 1. Vision 圖片輸入與 NAS 媒體儲存

圖片 bytes 統一放在 NAS，D1 只保存查詢、授權與清理所需的 metadata；Worker 不直接 mount NAS，也不把 NAS 絕對路徑或公開檔案網址交給瀏覽器、LINE 或模型。

NAS 目錄：

```text
/volume1/rueisiang-platform/
├── assistant/
│   └── vision/<yyyy>/<mm>/<object-id>.<ext>
└── wms/
    └── zones/<zone-id>/<yyyy>/<mm>/<object-id>.<ext>
```

- [ ] 建立 NAS 備份、保留期限、quota、重試與 orphan object reconciliation；storage gateway 不可因為單一圖片失敗拖垮一般文字對話。
- [ ] 接收 LINE image event：以 `messageId` 從 LINE Content API 取回 bytes，依 conversation scope 保存到 `assistant/vision/...`，並套用標註、群組授權與 expiry 規則。

### 2. MCP tools

- [ ] 先決定範圍：把平台內建 tools 暴露成 MCP server，或另外支援外部 MCP server；兩者的 authentication、權限與風險不同。
- [ ] 以現有 `ToolContract`、permission 與 surface registry 為基礎，建立 MCP transport、tool listing、tool call、timeout、錯誤格式與 audit log。
- [ ] 為 MCP client／server 設定 allowlist、credential 隔離、request size／rate limit 與取消機制，不能繞過目前 Sandbox／LINE 的 tool permission。
- [ ] 補上 protocol、權限、錯誤、重試與並行請求 tests，並提供本機與 Cloudflare deployment 的設定說明。

### 3. Relay 與用量

- [ ] 評估是否能以 [Cloudflare Workers TCP Sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) 的 outbound `connect()`／TLS stream 取代 NAS relay；先確認目標位址可達性、HTTP/SSE framing、Cloudflare IP／private network restrictions 與 Durable Object connection cost，再決定是否移除 relay。
- [ ] 在平台新增 LINE Push API 用量分析，至少顯示 fixed-window 用量、剩餘額度、查詢時間區間與群組／事件明細。

## 完成條件

每個階段都要同時具備程式碼、測試、文件與部署／回滾說明；沒有實機 smoke test 的功能只能標記為「可合併」，不能標記為「已上線」。
