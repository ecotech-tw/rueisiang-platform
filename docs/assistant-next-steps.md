# 小香下一階段任務

## 優先順序

### 1. Vision 圖片輸入與 NAS 媒體儲存

第一階段先建立 NAS 的私有媒體儲存，再把 Sandbox、LINE 與 WMS 接上同一個 storage gateway。Cloudflare Worker
不能直接 mount NAS 的檔案系統；Worker 只傳 namespace、由服務端產生的 object key 與短期授權，不能把 NAS
絕對路徑或公開檔案網址交給瀏覽器、LINE 或模型。

預定的 NAS 目錄（實際部署以 NAS 的 volume 大小寫為準）如下：

```text
/Volume1/rueisiang-platform/
├─ assistant/
│  └─ vision/<yyyy>/<mm>/<object-id>.<ext>
└─ wms/
   └─ zones/<zone-id>/<yyyy>/<mm>/<object-id>.<ext>
```

- [ ] 在 NAS 建立 `assistant` 與 `wms` namespace，並建立只允許服務帳號讀寫的 storage gateway；不要讓這兩個資料夾變成匿名公開分享。
- [ ] 讓 gateway 只經由 Cloudflare Tunnel 提供受驗證的 upload、download、delete、health endpoint；storage credential 與 Codex relay token 分開管理，並限制 namespace、content type、大小、檔名與 path traversal。
- [ ] D1 只保存 namespace、object key、原始檔名、MIME type、大小、checksum、建立者、建立時間與 expiry；圖片 bytes 留在 NAS，DO 只保留推論期間需要的短期 metadata。
- [ ] 先讓 WMS 倉位照片寫入 `wms/zones/<zone-id>/...`，規劃既有 `zone_images.object_key` 的 dual-read／migration，驗證完成前不要刪除現有 R2/GCS 來源。
- [ ] Sandbox 與 LINE 的圖片輸入寫入 `assistant/vision/...`；LINE image event 以 `messageId` 從 LINE Content API 取回 bytes 後再保存，未 tag 的群組圖片依 conversation scope 與 expiry 管理。
- [ ] 補上 NAS 備份、保留期限、quota、重試與 orphan object reconciliation；storage gateway 不可因為單一圖片失敗拖垮一般文字對話。

- [ ] Sandbox 新增圖片選擇、預覽、格式與大小驗證，API request 增加可選的 `attachments`；純文字請求維持向後相容。
- [ ] 將圖片轉成 Pi Agent、Codex 與 Gemini 各自支援的 image content，並對不支援 vision 的模型拒絕或提示切換模型。
- [ ] 補上 Sandbox、LINE 一對一、LINE 群組、圖片過期、大小／格式錯誤與兩個 provider 的 API tests，並更新操作文件。

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
