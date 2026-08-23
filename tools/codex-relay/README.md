# Pi Codex NAS relay

這是一個很小的 Node relay，讓 Worker 可以把 Pi 的 Codex SSE request 送到公司 NAS，再由 NAS 對
`https://chatgpt.com/backend-api/codex/responses` 建立第二段連線。它使用既有的 ChatGPT OAuth access token，
不會呼叫 OpenAI API key，因此不會因為這個 relay 額外產生 OpenAI API usage-based 費用；原本 ChatGPT／Codex
方案的使用限制仍然適用。

relay 不是任意 proxy：

- 只接受 `POST /codex/responses` 與不需驗證的 `GET /healthz`。
- 上游 host/path 固定為 `chatgpt.com/backend-api/codex/responses`。
- 必須帶 `X-Codex-Relay-Token`，且會用雜湊後的 timing-safe comparison 驗證。
- 不會把 relay token 轉送給上游，也不會記錄 request body、Authorization 或任何 token。
- 會移除 `cf-*`、`x-forwarded-*`、hop-by-hop、`Host`、`Content-Length` 等不應跨 proxy 傳遞的 header；Pi 的
  `Authorization`、`Content-Type` 與 SSE 相關 header 會保留。
- request/response body 以 stream 轉送，不把完整模型內容載入記憶體。

## 本機測試

```powershell
Set-Location tools/codex-relay
$env:CODEX_RELAY_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm test
npm run check
npm start
```

另一個 PowerShell 視窗可測健康檢查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

真正的 Codex endpoint 需要有效的 Pi access token，請不要把 token 貼到 command history、issue 或 log。

## Synology Container Manager

1. 在 NAS 上建立此資料夾並放入 `Dockerfile`、`docker-compose.yml`、`package.json`、`src/server.mjs`。
2. 在同一資料夾的 `.env` 設定一組高熵 token；`.env` 不要 commit：

   ```text
   CODEX_RELAY_TOKEN=<至少 32 bytes 的隨機字串>
   ```

3. 建置並啟動：

   ```bash
   docker compose up -d --build
   docker compose logs -f codex-relay
   ```

4. 先確認 NAS 本機的 `http://127.0.0.1:8787/healthz` 回傳 `{"ok":true}`。

現有 Cloudflare Tunnel 應新增一個專用 hostname，origin 指到 NAS relay 的 `http://<NAS LAN IP>:8787`。
不要開 router port forwarding；`cloudflared` 是由 NAS 對 Cloudflare 建立 outbound tunnel。若 Tunnel 前面再加
Cloudflare Access，Worker 必須另外帶 service token，這個 relay 目前只負責自己的 shared token 驗證。

Worker 使用 Tunnel hostname，例如：

```text
PI_OPENAI_CODEX_RELAY_URL=https://codex-relay.example.com
PI_OPENAI_CODEX_RELAY_TOKEN=<與 NAS CODEX_RELAY_TOKEN 相同的值>
```

兩個 Worker 設定必須同時存在；只設定其中一個會 fail closed。兩個都未設定時，系統維持原本直接連線
ChatGPT backend 的行為。第一階段只在 Sandbox 驗證，確認 NAS 直連真的成功後才考慮啟用任何 LINE 群組。

## 回滾與判斷

- 回滾：移除 Worker 的 `PI_OPENAI_CODEX_RELAY_URL` 與 `PI_OPENAI_CODEX_RELAY_TOKEN` 後重新部署；NAS relay
  可以保持關閉或繼續運行但不會被 Worker 使用。
- 如果 NAS relay 對同一個 credential 仍收到相同的 HTML 403，這不是單純 Worker `cf-*` header 問題；請保留
  relay log 的 request id/status/duration，停止嘗試修改或偽造 Cloudflare headers，改確認 upstream 對該
  credential、client 與網路來源的允許條件。
