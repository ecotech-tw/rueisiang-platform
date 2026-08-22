# 小香助理 Sandbox

這是 AI 內部問答系統的開發說明。目前 Sandbox 使用 Gemini；LINE 前台的正式回答則由
Pi Agent 與 Codex ChatGPT OAuth 執行。LINE 的架構、session 與 credential setup 見
[`line-pi-agent.md`](./line-pi-agent.md)；用量分析頁仍在後續階段。

## 本機操作

在 `apps/api/.dev.vars` 放入 Gemini key（這個檔案不進版控）：

```dotenv
GEMINI_API_KEY=你的_Gemini_API_Key
# 要讓已授權的 LINE 對話收到小香回答，還需要設定 Messaging API access token。
LINE_CHANNEL_ACCESS_TOKEN=你的_LINE_Channel_Access_Token
```

The LINE Channel Secret and Channel Access Token can also be entered in the LINE settings page. Both values are encrypted before they are stored; the existing `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN` Worker variables remain fallback options.

啟動本機環境（Codex worktree）：

```powershell
$env:API_PORT = "8788"
$env:PORTAL_PORT = "5174"
pnpm dev
```

開啟 `http://localhost:5174/dev`，選擇「林瑞翔」的假登入帳號，再進入「小香助理 → Sandbox」或「LINE 前台」。API 在 `http://localhost:8788`。第一次啟動會自動套用 D1 migration，並建立預設 prompt revision、Open-Meteo tool 與 LINE channel 設定。

## 第一階段提供的功能

- 使用 `warehouse-inventory` 的 Gemini 模型清單，支援模型切換；清單中的 quota 是 snapshot，不是即時配額。
- 同一個 Sandbox session 可以在每一輪送出前切換模型；切換會在該輪送出時套用，session 與每則模型回覆都會記錄實際使用的 model。
- Sandbox 選定模型後按「儲存並套用到小香」，會寫入 assistant 設定；之後沒有明確指定模型的執行會使用這個 active model。
- 編輯 system prompt；每次儲存會建立新 revision，並立即設為 active。
- Revision history 與 Sandbox tools 選擇都在 Modal 中操作；左側設定欄可獨立捲動，頁面外層不會跟著捲動。
- 選擇要傳給模型的 tool。目前內建唯讀工具預設為「已啟用」；管理者仍可切換成「開發中」或「已停用」。
- 輸入測試內容、看到模型回答、tool 呼叫結果、延遲與 Gemini usage metadata。
- Gemini thought summary 會在 Sandbox 以收合區塊顯示；正式回答不會重複渲染。LINE webhook 只傳送正式回答，thought summary 只寫入 Worker log，不會送給對話。
- 每次 Sandbox run 與 tool call 都會寫入 D1，欄位已預留給後續 LINE channel 與分析頁使用。
- 長對話超過上下文門檻時，送出前會以模型建立 rolling summary，並只把摘要與最近對話送給 Gemini；完整訊息仍保留在 D1 與 session history。摘要失敗時會退回最近對話，不會阻擋本次測試。
- `小香助理 → LINE 前台` 可以設定 Channel ID、Channel Secret、Channel Access Token、channel 開關、Webhook URL 與對話授權。
- Channel Secret 與 Channel Access Token 透過後台輸入後會使用 `AUTH_SESSION_SECRET` 以 AES-GCM 加密保存，不會把原值回傳到瀏覽器。`LINE_CHANNEL_SECRET` 與 `LINE_CHANNEL_ACCESS_TOKEN` 仍可作為既有部署的環境變數 fallback。
- LINE webhook 只接受 LINE 的 `x-line-signature`；群組／多人聊天室只記錄真正 mention 小香的文字訊息，一對一不需要 mention；新發現的對話預設未授權。
- 已授權且開通的 LINE 對話會由 `PI_AGENT_MODEL`、active prompt 與狀態為「已啟用」的 tools
  產生回答；一對一會同步使用者名稱與頭貼，「開發中」tool 仍只允許 Sandbox 使用。
- 一對一傳送 `/reset` 或 `/重設` 可清除目前模型上下文但保留歷史紀錄，不會觸發回答。

## 共用 Tool Contract：CRM 唯讀工具

CRM 工具與 WMS 使用同一個 provider-neutral `ToolContract`；目前三個 CRM 工具都註冊在 Sandbox、LINE 與未來 MCP。內建唯讀工具預設為「已啟用」，因此小香建立 channel 後即可使用完整工具集合；管理者仍可在後台把個別工具切換成「開發中」或「已停用」，LINE webhook 會尊重這個狀態。Sandbox 另外會依使用者的 CRM permission 檢查工具權限。

- `crm_search_customers`：依關鍵字、來源、狀態、標籤與 `YYYY-MM-DD` 日期搜尋客戶；`dateField=createdAt` 代表當天新增，`dateField=updatedAt` 代表當天更新。
- `crm_get_customer`：依客戶 ID 取得客戶資料、標籤、同步狀態、最近操作紀錄與可選的消費摘要。
- `crm_get_orders`：即時查詢 CYBERBIZ 訂單，支援 customer ID、order ID、訂單編號、日期、狀態、排序與 limit；需要 `crm:order:read`。

目前 `mcp` 是共用 registry 的 surface 標記，實際 MCP transport adapter 尚未在本 repo 建立（要接**外部** MCP 工具的話有額外的限制與風險，見 [`assistant-multi-channel.md`](./assistant-multi-channel.md) 第五節）；未來 GPT、Gemini 或遠端 MCP host 都可沿用同一批 tool definition、執行函式與權限宣告。CYBERBIZ 訂單工具使用即時 API，不會把訂單快照寫入 CRM。

每次 Sandbox 與 LINE 執行都會注入可信的 `Asia/Taipei` 日期與時間，模型可以用它把「今天」轉成 CRM tool 的 `date`、`fromDate` 與 `toDate`。消費工具查不到連結資料時會明確回報，不會用姓名猜測客戶或捏造訂單。

Open-Meteo 是無 API key 的公開測試 API；目前只用來驗證 tool calling，不是公司的知識來源，也不應被視為正式內部問答能力。後續 WMS、CRM 與公司文件搜尋會以同一個 `ToolContract` 介面接入，MCP adapter 會放在這層之下。

## 錯誤診斷與 Cloudflare logs

每次 Sandbox 執行都會產生一個診斷編號；Gemini 每一輪請求、回應、tool 執行、耗時與錯誤都會以 structured log 寫到 Worker Logs。Sandbox 只顯示 tool 的實際參數，參數不會寫入 Worker log；API key、完整 prompt 與完整對話也不會寫入 log。

每一則模型回覆的「工具調用」都可以展開查看參數；如果 Gemini 在工具執行後的下一輪請求失敗，Sandbox 也會在錯誤下方保留該次失敗前的工具調用，方便比對模型送出的參數。

正式環境可在 Cloudflare Dashboard 的 Workers & Pages → `rueisiang-platform` → Observability 查詢 `assistant.gemini.error`，再用畫面上的診斷編號篩選同一輪執行。也可以在有 Wrangler 的環境即時查看：

```bash
npx wrangler tail rueisiang-platform --format json --search assistant.gemini.error
```

目前 `apps/api/wrangler.toml` 已啟用 `[observability]`；修改程式後需部署一次，新的 structured logs 才會出現在 Cloudflare。Windows on ARM 本機因 Wrangler 的 `workerd` 不支援，建議使用 Cloudflare Dashboard 或 Linux/CI 執行 `wrangler tail`。

## LINE 回覆的執行方式與延遲診斷

LINE webhook 收到訊息後會先把工作寫入 Cloudflare Queue，再回傳 `accepted`；Queue consumer
負責 dispatch 到 chat 專屬 Durable Object，由 Pi Agent 執行 Codex、tool 與 session context，
完成後再呼叫 LINE Messaging API。正常路徑永遠優先使用 webhook event 的
`replyToken`；Queue 不設定 delivery delay。距離程式採用的 60 秒期限只剩 10 秒時，若推論仍未
完成，會先用 Reply API 回覆「系統繁忙，請稍後再試。」。完整結果完成後才嘗試受限 Push；
若 Push 不可用或額度已滿，完整結果仍會保存到 D1 的對話 relation，供系統備查。

Push 是 fallback，不是一般回覆 transport。台灣免費方案上限固定為每月 200 位收件者；月份
依 LINE 官方計費時區 GMT+9 的 `YYYY-MM` fixed window 計算。每次 Push 嘗試都寫入
`assistant_line_push_deliveries`，群組／room 依成員數而不是 API 呼叫次數扣額度。本地 ledger
會和 LINE quota consumption API 的回報取較高用量，失敗預約不釋放；Queue consumer 因此固定
`max_concurrency = 1`。Push 另帶與 Queue run 相同的 `X-Line-Retry-Key`，避免 consumer 重試造成
重複訊息。

每次 LINE 執行會使用同一個 `runId` 寫入 `assistant.run.*` 與 `assistant.line.reply.*` structured logs。請用 runId 比對以下事件：

- 沒有 `assistant.run.started`：工作沒有成功排入背景，或 webhook 在授權／設定階段就結束。
- 有 `assistant.run.failed`、沒有 `assistant.line.reply.started`：模型、tool 或設定失敗。
- 有 `assistant.line.reply.failed`：LINE Reply API 回傳錯誤；常見原因是 reply token 過期、重複使用或 message 格式錯誤，log 會保留 HTTP status 與受限長度的 API response。
- 有 `assistant.line.reply.completed` 但群組仍無訊息：檢查 LINE webhook event 是否真的帶入對應的 reply token，以及該 token 是否已被其他執行消耗。
- 有 `assistant.line.push.completed`：Reply 已進入逾時 fallback，完整回答已在 200 人 fixed window 內用 Push 送出。
- 有 `assistant.line.push.skipped`：成員數／遠端用量取不到，或本月 200 人額度已滿；完整回答查 `assistant_line_reply_backups`。
- 有 `assistant.line.push.failed`：已預約的收件人數仍保留，不因重試競態釋放；完整回答同樣留在備用表。

tool 失敗不會立即產生固定錯誤文字；失敗結果會回傳目前執行中的模型，讓它產生可理解的說明。
Sandbox 會保留該次 tool 的 args 與失敗訊息，LINE 只會收到 Pi Agent 的最終回答。LINE 的 AI
工作已經透過 Cloudflare Queues 與 webhook 解耦。

## API

Sandbox runs support multi-turn sessions. A session keeps the current model, prompt revision, rolling context summary, and full user/model messages together. The model in `POST /api/assistant/sandbox/run` takes precedence for an open session, so each turn can switch models; close a session to keep its history while preventing further runs. Long sessions summarize older messages before the request while keeping the full history in D1.

- `GET /api/assistant/sandbox/sessions`、`POST /api/assistant/sandbox/sessions`：列出或建立 Sandbox session。
- `GET /api/assistant/sandbox/sessions/:id`、`POST /api/assistant/sandbox/sessions/:id/close`：查看或關閉 session。
- `POST /api/assistant/sandbox/run`：帶入 `sessionId` 時，會依 session 的 rolling summary 與最近對話組裝上下文；若指定 `model`，會套用到本輪並更新開啟中的 session。

- `GET /api/assistant/sandbox/config`：模型、tool、active prompt 與 revision history。
- `PATCH /api/assistant/config`：儲存小香目前使用的模型。
- `PATCH /api/assistant/tools/:key`：更新 tool 的啟用、開發中或停用狀態。
- `POST /api/assistant/prompts`：建立並啟用新的 prompt revision。
- `POST /api/assistant/sandbox/run`：依指定模型、prompt revision 與 tool 執行一次測試。
- `GET /api/assistant/line/config`：LINE channel 狀態、Webhook URL、憑證是否已設定與對話清單；不回傳 credential 原值。
- `PATCH /api/assistant/line/config`：儲存 Channel ID、Channel Secret、Channel Access Token、顯示名稱與 channel 開關。
- `POST /api/assistant/line/groups`、`PATCH /api/assistant/line/groups/:id`：新增或授權對話。
- `POST /api/webhooks/line`：LINE 官方 webhook 入口。

上述後台路由需要已登入且具備對應的 `assistant:*` 權限；目前只有系統管理者預設擁有這些權限。LINE webhook 是 LINE 官方呼叫的公開入口，使用簽章驗證，不使用登入 cookie。

## 目前進度與後續階段

1. ✅ 已完成小香設定頁：active model 與 tool catalog 狀態可在後台調整。
2. ✅ 已完成 LINE channel 設定、webhook URL、對話授權與每對話訊息表；群組／聊天室須 mention，一對一不須 mention。
3. ✅ LINE 已改由 Pi Agent、Codex ChatGPT OAuth、active prompt 與 tool policy 執行；模型由
   `PI_AGENT_MODEL` 控制，僅允許「已啟用」工具在線上回覆。
4. ✅ Sandbox 已支援 session、多輪對話、歷史查看、關閉 session、每輪切換模型與長對話自動摘要。
5. 建立日／週／月與自訂 duration 的群組、模型、tool 用量分析頁。
6. 多帳號（官網客服自己的 LINE 官方帳號）、channel／對話兩層工具權限、每個對話的
   system prompt 補充，以及客服的身分驗證——設計見
   [`assistant-multi-channel.md`](./assistant-multi-channel.md)，尚未實作。
