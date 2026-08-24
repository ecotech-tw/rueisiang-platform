# 小香 Pi Agent、provider 與 session

Sandbox 與 LINE 的模型執行都使用 Pi Agent。選 GPT 時使用 Codex ChatGPT OAuth，選 Gemini
時使用 `GEMINI_API_KEY`；兩個 provider 共用 Pi transcript、tool loop、usage 與 compact。
vision upload 會再拆成後續 PR。LINE Queue consumer 會把每個已授權對話 dispatch 到 chat
專屬的 Durable Object；Sandbox session 也有自己的 Pi Durable Object。

`ASSISTANT_KEY` 不是 API key 或 secret，也不需要在 Cloudflare 設成環境變數。它是小香在 D1、
Queue 與 Durable Object instance name 共用的穩定內部識別碼；目前值是
`rueisiang-xiaoxiang`，用來避免未來新增其他 assistant 時混到設定與 session。

```text
LINE webhook／Sandbox API → chat Durable Object → Pi Agent
  → GPT／Codex（ChatGPT OAuth）或 Gemini（API key）→ platform tools／D1
  → Pi Agent 最終回答 → LINE Reply API
  → 接近 reply token 期限時才使用受限 Push fallback
```

GPT／Codex 路徑不使用 `OPENAI_API_KEY`，因此不走 OpenAI API 的 usage-based billing。實際可用量
仍受登入的 ChatGPT 方案與 Codex 使用限制約束；目前只應開放給內部、已在 LINE 前台授權的
對話，不應把個人 ChatGPT credential 當成公開或多租戶服務憑證。登入與方案差異見
[OpenAI Codex authentication](https://developers.openai.com/codex/auth)。

## Pi 與 Cloudflare 各自負責什麼

這裡不是只把 Pi 當 HTTP proxy：

- Pi `Agent` 負責 transcript message 格式、模型迴圈、tool calling、usage 與 compaction summary。
- 每個 LINE 對話與每個 Sandbox session 都有自己的 SQLite Durable Object，負責依序執行、
  保存 Pi transcript、run idempotency、alarm compaction 與 session generation。
- D1 保留 LINE 原始訊息、Sandbox UI／稽核投影、平台設定、工具授權、執行用量與逾時備用
  回答；第一輪可由 D1 bootstrap 舊 Sandbox session，之後不再於每一輪重拼模型 prompt。
- 全平台共用一個 credential-vault Durable Object，集中旋轉 refresh token，避免多個對話
  同時 refresh 後互相覆蓋。credential 在 vault SQLite 內以 AES-GCM 加密。

Pi 0.84.2 的 `AgentHarness` durable methods 尚未實作，因此目前使用完整可運作的 `Agent`，
外加 Cloudflare persistence adapter。這仍保留 Pi 的 context/tool-loop 語意，也不需要另外付費
運行 Node container；Pi CLI 本身依賴 filesystem/process，不適合直接塞進 Workers runtime。

SQLite Durable Objects 可使用 Cloudflare Workers Free plan；部署時的 DO migration 會建立
class，不需要到 Dashboard 手動建立 instance。限制與計價以
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
與 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 為準。模型串流主要是
網路等待，但 Pi 的 parsing、tool schema 與 compaction 仍消耗 Worker CPU，正式部署後要監控
CPU time、subrequest、DO storage 與 Queue retry，不能把「可部署」視為「一定不會碰 Free quota」。

## Session、compact 與 reset

- LINE session identity 由 assistant、LINE channel、來源類型與 LINE chat ID 組成；Sandbox
  identity 由 assistant、登入使用者與 Sandbox session ID 組成。不同人、群組與 session 不會共用上下文。
- 同一 chat DO 內的 run 會序列化，避免兩則訊息交錯改寫 transcript。
- 約 48,000 tokens 後以 DO alarm 執行 Pi compaction，摘要舊內容並保留約 12,000 tokens 的最近
  對話；超過 80,000 tokens 時，下一輪推論前會先強制 compact。
- 一對一傳送精確的 `/reset` 或 `/重設` 會更新 D1 的 `contextResetAt`，並讓 DO 旋轉成新的
  session。舊 Queue 工作會因 generation 不符而略過，LINE 原始訊息與舊 Pi transcript 不刪除。
- failed 或 aborted run 會保留供診斷，但不會混入下一輪模型 context；相同 `runId` 的 Queue
  重試會回傳既有成功結果，未完成的殘留 transcript 則會先清掉。

## 模型與延遲設定

小香初始模型是 `gpt-5.4-mini`。管理者在 Sandbox 儲存的 active model 同時套用到 Sandbox 與
LINE；只有資料庫還沒有 assistant 設定時才讀 Worker var `PI_AGENT_MODEL`。Sandbox 模型選單
列出目前 Pi catalog 支援的 Codex 與 Gemini 模型，並分別檢查 OAuth credential 與 API key。
為優先守住 LINE reply token，LINE 執行固定採用：

- minimal reasoning、low verbosity；
- 單次模型請求 25 秒 timeout、不做模型層 retry；
- 最多 1,200 output tokens，LINE 最終文字最多 4,500 字元；
- system prompt 預設要求直接使用繁體中文短答。

Queue retry、LINE reply deadline 與每月 200 位收件者的 Push fixed window 仍由既有 transport
處理。Pi 推論若進入 reply token 的十秒安全緩衝區，使用者先收到「系統繁忙，請稍後再試。」；
完整結果完成後才嘗試受限 Push，否則保存在 D1 並關聯原 chat ID。

## Optional NAS Codex relay

若 production 的 Worker 直接連線 `chatgpt.com/backend-api` 持續收到 Cloudflare HTML 403，
可以先依 [`tools/codex-relay/README.md`](../tools/codex-relay/README.md) 在 NAS 啟動固定目的地的 relay。
它不使用 `OPENAI_API_KEY`，只轉送既有的 ChatGPT OAuth access token；relay 本身不會增加 OpenAI API
usage-based 費用，但仍受 ChatGPT／Codex 方案的使用限制約束。

Workers TCP Sockets 不是這個 relay 的替代方案。我們在 Cloudflare remote runtime 實際以
`connect({ hostname: "chatgpt.com", port: 443, secureTransport: "on" })` 探測，收到
`cannot connect to the specified address`；Cloudflare 也明確限制 outbound TCP 連到 Cloudflare IP
range。因此目前仍須保留 NAS relay，不能只因 TCP socket API 存在就移除 NAS 上的服務。raw HTTP／SSE
transport 可以處理 request header、response framing、chunked body 與 stream abort，但這些都發生在
socket 建立成功之後，無法繞過這個 runtime 的 egress restriction。

另一個待評估的 Cloudflare 原生路徑是 Workers VPC 的 `cf1:network` binding，讓 HTTP request 經
Cloudflare Gateway public egress；這不是單純再包一層 Worker。它目前仍是 beta，需要 Connectivity
Directory 權限與帳號的 VPC／Gateway 設定；本 repo 的 CI token 實測回傳 VPC authorization code `10196`，
尚未驗證 ChatGPT response。因此在完成權限設定、Cloudflare Gateway policy 與真實 Codex SSE 驗收前，
仍以 NAS relay 為正式路徑。

Worker 端只有在兩個設定都存在時才會啟用 relay：

| 設定 | 類型 | 說明 |
|---|---|---|
| `PI_OPENAI_CODEX_RELAY_URL` | variable | Cloudflare Tunnel 對外的 HTTPS origin，例如 `https://codex-relay.example.com` |
| `PI_OPENAI_CODEX_RELAY_TOKEN` | secret | 與 NAS `CODEX_RELAY_TOKEN` 相同的高熵字串 |

本機 Sandbox 可在 `apps/api/.dev.vars` 使用：

```text
PI_OPENAI_CODEX_RELAY_URL=http://127.0.0.1:8787
PI_OPENAI_CODEX_RELAY_TOKEN=<與本機 relay 相同的 token>
```

兩者都未設定時維持 Worker 直連；只設定一個時 Codex request 會 fail closed。第一階段只在 Sandbox
驗收，NAS relay 仍回傳 HTML 403 時就停止修改 header，改回頭確認 credential 與上游服務的允許條件。

## Credential setup

先在可信任的本機用 Codex CLI 登入 ChatGPT。Windows 預設 credential 位於
`%USERPROFILE%\.codex\auth.json`。不要把檔案或以下輸出 commit、貼進 issue、PR 或 log。

完整 Codex auth file 可能太大；可在 PowerShell 只把必要欄位複製到剪貼簿：

```powershell
$codexAuth = Get-Content "$env:USERPROFILE\.codex\auth.json" -Raw | ConvertFrom-Json
@{
  access = $codexAuth.tokens.access_token
  refresh = $codexAuth.tokens.refresh_token
} | ConvertTo-Json -Compress | Set-Clipboard
```

到 Cloudflare Worker 的 **Settings → Variables and Secrets** 新增兩個 Codex Secret：

| 名稱 | 值 |
|---|---|
| `PI_OPENAI_CODEX_CREDENTIAL` | 上一步剪貼簿內的 JSON；也接受 Pi `auth.json` 的 `openai-codex` credential |
| `PI_CREDENTIAL_ENCRYPTION_KEY` | 至少 32 字元的獨立高熵字串 |

加密 key 可在本機產生：

```bash
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

vault 第一次使用時會讀取 seed，之後保存並旋轉最新 credential。系統會記住 seed 的 SHA-256
fingerprint；重新登入後更新 `PI_OPENAI_CODEX_CREDENTIAL`，下一次請求會自動重新灌入。不要單獨
更換 encryption key，否則既有 vault 資料無法解密；若必須輪替，請同時重新登入並更新兩個值。
Worker 永遠只從 vault RPC 取得短效 access token，不會把 refresh token 複製到每個 chat DO。

若要使用 Gemini 模型，再新增 `GEMINI_API_KEY`。兩種 provider 可以只設一種；Sandbox 會停用
缺少 credential 的那組模型。若 active model 所屬 provider 未設定，API 會明確回傳 503，不會
偷偷改用另一個 provider。

本機 `tsx` API server 會以 Node SQLite adapter 模擬 chat DO 與 credential vault，所以可在
Sandbox 測 Gemini API key 或 Codex OAuth；正式 LINE Queue、Cloudflare alarm 與真實 DO migration
仍要部署後驗證。本機不可執行 Wrangler 的限制仍以 [`deployment-setup.md`](./deployment-setup.md)
為準。
