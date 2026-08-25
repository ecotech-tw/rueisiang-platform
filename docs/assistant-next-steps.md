# 小香下一階段任務

## 優先順序

### 1. Vision 圖片輸入與 NAS 媒體儲存 ✅

圖片 bytes 統一放在 NAS，D1 只保存查詢、授權與清理所需的 metadata；Worker 不直接 mount NAS，也不把 NAS 絕對路徑或公開檔案網址交給瀏覽器、LINE 或模型。

NAS 目錄：

```text
/volume1/rueisiang-platform/
├── assistant/
│   └── vision/<chat-id>/<yyyy>/<mm>/<object-id>.<ext>
└── wms/
    └── zones/<zone-id>/<yyyy>/<mm>/<object-id>.<ext>
```

- [x] Sandbox vision 圖片與 WMS 倉位照片已透過 NAS storage gateway 儲存，D1 保存 metadata；讀取、刪除、expiry 與 production smoke test 已接通。
- [ ] 建立 NAS 備份、保留期限、quota、重試與 orphan object reconciliation；storage gateway 不可因為單一圖片失敗拖垮一般文字對話。
- [ ] 接收 LINE image event：以 `messageId` 從 LINE Content API 取回 bytes，依 LINE chat id 保存到 `assistant/vision/<chat-id>/...`，並套用標註、群組授權與 expiry 規則。
  - webhook handler 只驗證、記錄事件並 enqueue；bytes 在 queue consumer 以 channel access token 呼叫 `https://api-data.line.me/v2/bot/message/{messageId}/content`，不可在 webhook request 內等待下載。
  - LINE 圖片事件沒有 self mention；群組／多人聊天室先保存受控的 pending attachment，只有後續文字 self mention 引用該圖片的 `quotedMessageId` 時才送入 AI context。無法可靠引用時，不用「最近幾秒的圖片」猜測，避免把別人的圖片帶進問題。
  - 一對一圖片可直接成為一個 user turn；群組與 room 仍遵守「self mention 才觸發回覆」。`webhookEventId`、`messageId` 與 redelivery 狀態要做冪等，並以事件 timestamp 處理重送亂序。
  - D1 需保存 LINE message 與 media object 的關聯、content type、size、checksum、expiresAt 和下載狀態；圖片 bytes 只進 NAS，第一個 phase 先支援 image，video／audio 另行評估。

### 2. MCP tools

- [ ] 先決定範圍：把平台內建 tools 暴露成 MCP server，或另外支援外部 MCP server；兩者的 authentication、權限與風險不同。
- [ ] 以現有 `ToolContract`、permission 與 surface registry 為基礎，建立 MCP transport、tool listing、tool call、timeout、錯誤格式與 audit log。
- [ ] 為 MCP client／server 設定 allowlist、credential 隔離、request size／rate limit 與取消機制，不能繞過目前 Sandbox／LINE 的 tool permission。
- [ ] 補上 protocol、權限、錯誤、重試與並行請求 tests，並提供本機與 Cloudflare deployment 的設定說明。

### 3. Relay 與用量

- [x] 已驗證（2026-08-24）：Cloudflare remote Workers smoke test 以 outbound `connect()`／TLS stream 連線 `chatgpt.com:443`，runtime 回傳 `cannot connect to the specified address`，因此 TCP Sockets 不能繞過 ChatGPT backend 的連線拒絕。即使補上 raw HTTP／SSE 的 header parsing、chunked decoding 與 abort handling，仍會在建立 socket 前失敗。依 [Cloudflare TCP Sockets 限制](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) 與目標使用 Cloudflare IP range 的現況，保留 NAS relay；未來只有改用允許的上游 endpoint 並完成真實 SSE 驗收後，才可重新評估移除。
- [ ] 評估 [Workers VPC `cf1:network`](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) 經 Cloudflare Gateway 的 public egress，確認是否能避開 Workers direct egress restriction 與 `CF-Worker` header；目前 smoke test 因 CI token 沒有 Connectivity Directory 權限而回傳 code `10196`，尚未驗證 ChatGPT HTTP／SSE。完成權限、VPC／Gateway policy 與真實 Codex SSE 驗收前，不得移除 NAS relay。
- [ ] 在平台新增 LINE Push API 用量分析，至少顯示 fixed-window 用量、剩餘額度、查詢時間區間與群組／事件明細。

## 完成條件

每個階段都要同時具備程式碼、測試、文件與部署／回滾說明；沒有實機 smoke test 的功能只能標記為「可合併」，不能標記為「已上線」。
