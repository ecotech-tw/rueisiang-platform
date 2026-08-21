# 小香助理 Sandbox

這是 AI 內部問答系統的第一階段。這一階段只提供後台 Sandbox，尚未接 LINE webhook、群組授權或用量分析頁。

## 本機操作

在 `apps/api/.dev.vars` 放入 Gemini key（這個檔案不進版控）：

```dotenv
GEMINI_API_KEY=你的_Gemini_API_Key
```

啟動本機環境：

```bash
pnpm dev
```

開啟 `http://localhost:5173/dev`，選擇「林瑞翔」的假登入帳號，再進入「小香助理 → Sandbox」。第一次啟動會自動套用 D1 migration，並建立預設 prompt revision 與 Open-Meteo tool 設定。

## 第一階段提供的功能

- 使用 `warehouse-inventory` 的 Gemini 模型清單，支援模型切換；清單中的 quota 是 snapshot，不是即時配額。
- Sandbox 選定模型後按「儲存並套用到小香」，會寫入 assistant 設定；之後沒有明確指定模型的執行會使用這個 active model。
- 編輯 system prompt；每次儲存會建立新 revision，並立即設為 active。
- 選擇要傳給模型的 tool。現在只有 `Open-Meteo 天氣查詢`，狀態預設為「開發中」。
- 輸入測試內容、看到模型回答、tool 呼叫結果、延遲與 Gemini usage metadata。
- 每次 Sandbox run 與 tool call 都會寫入 D1，欄位已預留給後續 LINE channel 與分析頁使用。

Open-Meteo 是無 API key 的公開測試 API；目前只用來驗證 tool calling，不是公司的知識來源，也不應被視為正式內部問答能力。後續 WMS、CRM 與公司文件搜尋會以同一個 `AssistantToolDefinition` 介面接入，MCP adapter 會放在這層之下。

## API

- `GET /api/assistant/sandbox/config`：模型、tool、active prompt 與 revision history。
- `PATCH /api/assistant/config`：儲存小香目前使用的模型。
- `PATCH /api/assistant/tools/:key`：更新 tool 的啟用、開發中或停用狀態。
- `POST /api/assistant/prompts`：建立並啟用新的 prompt revision。
- `POST /api/assistant/sandbox/run`：依指定模型、prompt revision 與 tool 執行一次測試。

上述路由需要已登入且具備 `assistant:sandbox:read` 或 `assistant:sandbox:write` 權限；目前只有系統管理者預設擁有這兩個權限。

## 目前進度與後續階段

1. ✅ 已完成小香設定頁：active model 與 tool catalog 狀態可在後台調整。
2. 建立 LINE channel 設定、webhook URL、群組 allowlist 與每群組的對話訊息表。
3. 將 active model、active prompt 與 tool policy 套用到 LINE 執行，僅允許「已啟用」工具在線上回覆。
4. 建立日／週／月與自訂 duration 的群組、模型、tool 用量分析頁。
