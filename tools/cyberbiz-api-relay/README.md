# CYBERBIZ API relay

讓平台 Worker 經由公司 NAS 的固定公網出口呼叫 CYBERBIZ App Store API。這不是任意 proxy：上游 host 固定為 `app-store-api.cyberbiz.io`，只允許平台目前使用的 customer、product、stock adjustment 與 order routes。

Relay 不保存 CYBERBIZ API token。Worker 將 `Authorization: Bearer ...` 送給 relay，relay 只在記憶體中轉送；relay access token 與 CYBERBIZ API token 是兩把不同的密鑰，log 不記錄任何 token、request body 或 response body。

## NAS 部署

先確認公司網路業者提供的固定公網出口 IP，並請 CYBERBIZ 加入 API 白名單。`curl https://api.ipify.org` 顯示的單次結果不能證明 IP 固定。

把此資料夾放至 NAS，例如 `/volume1/docker/rueisiang-platform-cyberbiz-api-relay`，建立 `.env`：

```dotenv
CYBERBIZ_RELAY_TOKEN=<至少 32 bytes 的高熵亂數，勿與其他 NAS token 共用>
```

在該資料夾執行：

```bash
docker compose up -d --build
curl http://127.0.0.1:8791/healthz
```

Cloudflare Tunnel 新增專用 hostname，例如 `cyberbiz-relay.rueisiang.com`，origin 指向 `http://192.168.0.6:8791`。不要開 router port forwarding。不要把 hostname 指到 storage gateway。

## Worker 設定

Tunnel hostname 可連線且 CYBERBIZ 已完成白名單後，設定：

- 非機密的 `CYBERBIZ_API_RELAY_URL=https://cyberbiz-relay.rueisiang.com` 加到 `apps/api/wrangler.toml`，只在 Tunnel 與 NAS relay 已可用後啟用。
- Worker secret `CYBERBIZ_API_RELAY_TOKEN`：與 NAS `.env` 的 `CYBERBIZ_RELAY_TOKEN` 相同。
- Worker secret `CYBERBIZ_API_TOKEN`：CYBERBIZ 最新核發的 App Store API token。

`CYBERBIZ_API_RELAY_URL` 與 `CYBERBIZ_API_RELAY_TOKEN` 必須成對設定；只設一個會拒絕建立 CYBERBIZ client，不會悄悄切回直連。CYBERBIZ webhook 仍直接送到平台 Worker，不經此 relay；只有平台向 CYBERBIZ 發出的 API request 會改走 NAS。

完成設定後從 CRM 同步頁與 WMS 庫存頁測試。回滾時同時移除 Worker 的 relay URL 與 relay token，即回到直接呼叫 CYBERBIZ 的路徑。

## 測試

```bash
npm test
npm run check
```
