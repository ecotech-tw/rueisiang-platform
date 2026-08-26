# 小香下一階段任務

## 優先順序

### 1. MCP tools

- [ ] 先決定範圍：把平台內建 tools 暴露成 MCP server，或另外支援外部 MCP server；兩者的 authentication、權限與風險不同。
- [ ] 以現有 `ToolContract`、permission 與 surface registry 為基礎，建立 MCP transport、tool listing、tool call、timeout、錯誤格式與 audit log。
- [ ] 為 MCP client／server 設定 allowlist、credential 隔離、request size／rate limit 與取消機制，不能繞過目前 Sandbox／LINE 的 tool permission。
- [ ] 補上 protocol、權限、錯誤、重試與並行請求 tests，並提供本機與 Cloudflare deployment 的設定說明。

### 2. Relay 與用量

- [ ] 評估 [Workers VPC `cf1:network`](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) 經 Cloudflare Gateway 的 public egress，確認是否能避開 Workers direct egress restriction 與 `CF-Worker` header；目前 smoke test 因 CI token 沒有 Connectivity Directory 權限而回傳 code `10196`，尚未驗證 ChatGPT HTTP／SSE。完成權限、VPC／Gateway policy 與真實 Codex SSE 驗收前，不得移除 NAS relay。
- [ ] 在平台新增 LINE Push API 用量分析，至少顯示 fixed-window 用量、剩餘額度、查詢時間區間與群組／事件明細。

## 完成條件

每個階段都要同時具備程式碼、測試、文件與部署／回滾說明；沒有實機 smoke test 的功能只能標記為「可合併」，不能標記為「已上線」。
