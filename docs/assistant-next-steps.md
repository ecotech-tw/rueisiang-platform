# 小香下一階段任務

這份文件記錄 #81～#84 上線後的工作。它本身不改變目前的 LINE、Queue、Pi Agent、Sandbox 或 provider 行為；vision 與 MCP 都等核心 PR 上線並完成 smoke test 後再另外開 PR。

## 優先順序

### 0. #81～#84 上線驗收

- [ ] 套用所有 D1 migration，確認 Queue、Dead Letter Queue 與 Durable Object bindings 已建立。
- [ ] 設定並確認 LINE channel、`PI_OPENAI_CODEX_CREDENTIAL`、`PI_CREDENTIAL_ENCRYPTION_KEY`、`GEMINI_API_KEY` 等 secret。
- [ ] 實機驗證 LINE 一對一、群組 @ 小香、群組未 @、session reset backdoor、reply deadline 與 Push fixed-window quota。
- [ ] 實機驗證 Sandbox 的 Codex OAuth、Gemini API key、模型切換、既有 session bootstrap、compact 與失敗後重試。
- [ ] 檢查 Queue retry/DLQ、D1 outbox、reply backup 與 structured logs，確認可用 `runId`／correlation id 追查一次請求。

### 1. Vision 圖片輸入

- [ ] Sandbox 新增圖片選擇、預覽、格式與大小驗證，API request 增加可選的 `attachments`；純文字請求維持向後相容。
- [ ] LINE webhook 處理 image event，使用 `messageId` 透過 LINE Content API 取得圖片。
- [ ] 圖片只在 Worker／Pi Agent 執行期間暫存於記憶體，不使用 R2 長期保存；DO 只保存必要的短期 metadata 與 expiry。
- [ ] 群組未 tag 的圖片要與對話關聯，保留到明確提問或到期；到期後要清楚告知圖片已不可用。
- [ ] 將圖片轉成 Pi Agent、Codex 與 Gemini 各自支援的 image content，並對不支援 vision 的模型拒絕或提示切換模型。
- [ ] 補上 Sandbox、LINE 一對一、LINE 群組、圖片過期、大小／格式錯誤與兩個 provider 的 API tests，並更新操作文件。

### 2. MCP tools

- [ ] 先決定範圍：把平台內建 tools 暴露成 MCP server，或另外支援外部 MCP server；兩者的 authentication、權限與風險不同。
- [ ] 以現有 `ToolContract`、permission 與 surface registry 為基礎，建立 MCP transport、tool listing、tool call、timeout、錯誤格式與 audit log。
- [ ] 為 MCP client／server 設定 allowlist、credential 隔離、request size／rate limit 與取消機制，不能繞過目前 Sandbox／LINE 的 tool permission。
- [ ] 補上 protocol、權限、錯誤、重試與並行請求 tests，並提供本機與 Cloudflare deployment 的設定說明。

## 完成條件

每個階段都要同時具備程式碼、測試、文件與部署／回滾說明；沒有實機 smoke test 的功能只能標記為「可合併」，不能標記為「已上線」。
